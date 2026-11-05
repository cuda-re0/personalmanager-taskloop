import type { Occurrence, PointEntry, Task } from '../../shared/types/domain'
import type { PointsConfig } from '../../shared/points/rubric'
import {
  computeDailyPoints,
  computePlannedPoints,
  roundPoints
} from '../../shared/points/rubric'
import type { DayStat, Difficulty, TaskType } from '../../shared/types/domain'
import { tx } from '../db/connection'
import { appError } from '../db/errors'
import { addDays, isoWeekday, monthBounds, nowIso, todayLocalDay } from '../db/localDay'
import { newId } from '../db/ids'
import { MAX_SPEND_CENTS } from '../../shared/points/spend'
import * as fxService from './fxService'
import * as occurrenceService from '../db/occurrenceService'
import * as ledgerRepo from '../db/repositories/ledgerRepo'
import * as occurrenceRepo from '../db/repositories/occurrenceRepo'
import * as settingRepo from '../db/repositories/settingRepo'
import * as statsRepo from '../db/repositories/statsRepo'
import * as taskRepo from '../db/repositories/taskRepo'

/**
 * pointsService —— 积分的数据访问 + 精度收敛 + **每日任务的计分编排**（01 §2.4 / 02 §5）。
 *
 * 边界（W6 起）：
 * - 分值只由 `rubric.ts` 算：本文件不复制任何公式，`roundPoints` 是唯一的取整点。
 * - 编排只管「哪几条流水、streak 是多少、occurrence 落到什么状态」；
 *   具体列怎么写交给 occurrenceService（db 层），本文件开事务。
 * - 限时/活动的完成事务在 taskService.completeTask（02 §3.2），本文件只提供 `award` / `rollback` 零件。
 *
 * 精度纪律（08 DELTA · D1）：本文件不出现任何取整/定点格式化调用。
 */

/** 连续天数的扫描上限（约 10 年）：纯防御，避免稀疏 repeat_rule 下的死循环 */
const STREAK_SCAN_LIMIT = 3660


export function balance(): number {
  return ledgerRepo.balance()
}

export function listLedger(options: { from?: string; to?: string; limit?: number } = {}): PointEntry[] {
  return ledgerRepo.list(options)
}

export function recentLedger(limit = 20): PointEntry[] {
  return ledgerRepo.recent(limit)
}

export function monthStats(year: number, month: number): DayStat[] {
  return statsRepo.monthStats(year, month)
}

export function todayStat(): DayStat {
  return statsRepo.getDay(todayLocalDay())
}

/**
 * 指定本地日历日的统计（v0.67：聊天简报取「昨天」用）。
 * 纯转发：不新增表、不加缓存，`todayStat()` 也不必改成调它。
 */
export function dayStatOf(day: string): DayStat {
  return statsRepo.getDay(day)
}

/** settings['points.*'] → rubric 的配置对象（02 §5.1） */
export function pointsConfig(): PointsConfig {
  return {
    difficultyBase: settingRepo.get('points.difficultyBase'),
    deadlineBase: settingRepo.get('points.deadlineBase'),
    dailyBase: settingRepo.get('points.dailyBase'),
    streakBonus: settingRepo.get('points.streakBonus'),
    dailyCap: settingRepo.get('points.dailyCap')
  }
}

/**
 * `points.preview`：纯计算、无副作用。daily 返回的是**单日**分值。
 *
 * v0.7（契约 v0.9）起 `estimateMin` 退出公式，参数只剩难度；`ipc.ts` 的
 * `points.preview` 载荷也同步删了那个字段，这里跟着收窄，不要为了兼容塞个可选参数。
 */
export function previewPoints(type: TaskType, difficulty: Difficulty): number {
  const cfg = pointsConfig()
  if (type === 'daily') return roundPoints(cfg.dailyBase)
  return computePlannedPoints(type, difficulty, cfg)
}

/** `points.streakPreview`：连续到 streakAfter 那天能拿到的里程碑奖励，0 = 无 */
export function streakBonusAt(streakAfter: number): number {
  return computeDailyPoints(streakAfter, pointsConfig()).bonus
}

export interface AwardInput {
  taskId?: string | null
  occurrenceId?: string | null
  /** 未收敛的原始分值，写库前统一过 roundPoints */
  delta: number
  kind?: PointEntry['kind']
  reasonCode: PointEntry['reasonCode']
  reasonText?: string
  /** 归属的本地日历日，默认今天 */
  day?: string
  id?: string
}

/**
 * 写一条流水并同步当日聚合。调用方必须已经在业务事务里，或直接用本函数（内部自带 tx）。
 *
 * 唯一索引会在这里挡重复：
 * - `uq_ledger_task_done`：同一任务（occurrence_id 为 NULL）的第二条 `task_done` 被拒
 * - `uq_ledger_occurrence`：同一 occurrence 的第二次发分被拒
 */
export function award(input: AwardInput): PointEntry {
  const day = input.day ?? todayLocalDay()
  const delta = roundPoints(input.delta)
  return tx(() => {
    const entry = ledgerRepo.insert({
      id: input.id ?? newId(),
      taskId: input.taskId ?? null,
      occurrenceId: input.occurrenceId ?? null,
      delta,
      kind: input.kind ?? (delta < 0 ? 'penalty' : 'award'),
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? '',
      day,
      createdAt: nowIso()
    })
    statsRepo.addPoints(day, delta)
    return entry
  })
}

/** `points.adjust`：手动加减，`kind='adjust'`，不挂任务 */
export function adjust(delta: number, reasonText: string): PointEntry {
  const rounded = roundPoints(delta)
  if (rounded === 0) throw appError('INVALID_INPUT', '调整分不能为 0')
  return award({
    taskId: null,
    occurrenceId: null,
    delta: rounded,
    kind: 'adjust',
    reasonCode: 'manual_adjust',
    reasonText
  })
}

/**
 * 撤销（`task.undo` / `occurrence.undo`）写一条负流水冲销，并把原发分行标为已冲销。
 *
 * 两步缺一不可（01 §2.4，v0.19）：
 * - **负流水**：余额是 `SUM(delta)`，不写负行等于没撤销；
 * - **`markReversed`**：两条条件唯一索引的谓词是 `reversed_at IS NULL`，
 *   不标时间戳的话，撤销后重做会撞索引——task 级报「已经发过完成分了」，
 *   occurrence 级报「这一天的打卡已经发过分了」（每日任务误点撤销后当天再也打不上卡）。
 *
 * 冲销行本身仍是 `occurrence_id = NULL` + `reason_code = 'manual_adjust'`：
 * 它不该占用任何一个"有效发分"的坑位；原单号写进 reason_text 便于对账。
 */
export function rollback(entry: PointEntry, reasonText: string): PointEntry {
  ledgerRepo.markReversed(entry.id, nowIso())
  return award({
    taskId: entry.taskId,
    occurrenceId: null,
    delta: -entry.delta,
    kind: 'adjust',
    reasonCode: 'manual_adjust',
    reasonText: reasonText || `撤销 ${entry.id}`,
    day: todayLocalDay()
  })
}

/* ------------------------------------------------------------------ *
 * 零花钱：支出记账（v0.45，45 §5.1）
 * ------------------------------------------------------------------ */

export interface SpendInput {
  /** 整数「分」。渲染层用字符串拆解得来，不许是浮点乘 100 的产物 */
  amountCents: number
  note?: string
}

/**
 * `points.spend`：花一笔钱，按当期汇率扣积分。
 *
 * 为什么不复用 `adjust()`：它的 `kind` / `reasonCode` 是写死的（`adjust` / `manual_adjust`），
 * 硬塞进去之后「手动调整」和「花钱」在明细里就混成一类，账再也对不清。
 *
 * 扣分公式 `delta = -roundPoints(amountCents / 100 / rate)`：汇率是"1 积分值多少元"，
 * 所以花掉的钱要**除以**汇率才是积分。取整只走 `roundPoints`（本文件不做别的取整）。
 */
export function spend(input: SpendInput): PointEntry {
  const amountCents = input.amountCents
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw appError('INVALID_INPUT', '金额必须是正数', {
      detail: `amountCents=${String(amountCents)}`
    })
  }
  // 单笔上限放这里而不是 guard：guard 失败只能返回「请求参数格式不正确」，给不出人话
  if (amountCents > MAX_SPEND_CENTS) {
    throw appError('INVALID_INPUT', '单笔支出不能超过 1000 元', {
      detail: `amountCents=${amountCents} > ${MAX_SPEND_CENTS}`
    })
  }

  const { rate } = fxService.currentRate()
  const delta = -roundPoints(amountCents / 100 / rate)
  if (delta === 0) {
    // 不写 0 分流水：一条 0 分的支出行在明细里既看不懂也没意义
    throw appError('INVALID_INPUT', '金额太小，扣不进积分', {
      detail: `amountCents=${amountCents} rate=${rate}`
    })
  }

  const day = todayLocalDay()
  return tx(() => {
    const entry = ledgerRepo.insert({
      id: newId(),
      taskId: null,
      occurrenceId: null,
      delta,
      kind: 'spend',
      reasonCode: 'pocket_spend',
      reasonText: input.note ?? '',
      day,
      createdAt: nowIso(),
      amountCents,
      fxRate: rate
    })
    statsRepo.addPoints(day, delta)
    return entry
  })
}

export interface SpendMonthResult {
  entries: PointEntry[]
  /** 本月有效支出合计（分），已扣掉撤销过的 */
  totalCents: number
  rate: number
  weekStart: string
}

/** `points.spendMonth`：只看**当前月**，不传参——界面没有翻月需求 */
export function spendMonth(): SpendMonthResult {
  const day = todayLocalDay()
  const [year, month] = day.split('-').map(Number)
  const { from, to } = monthBounds(year, month)
  const { rate, weekStart } = fxService.currentRate()
  return {
    entries: ledgerRepo.listSpend(from, to),
    totalCents: ledgerRepo.sumSpendCents(from, to),
    rate,
    weekStart
  }
}

/**
 * `points.spendUndo`：撤销一笔支出。
 *
 * 复用 `rollback()`（打 `reversed_at` + 写一条反向 `adjust` 行），**不真删流水**：
 * 账本一旦写下就是事实，撤销只是"又发生了一件事"。`rollback` 一个字都不改——
 * 它同时服务任务撤销，改坏了 `uq_ledger_task_done` 的谓词会一起崩。
 */
export function spendUndo(entryId: string): PointEntry {
  return tx(() => {
    const entry = ledgerRepo.byId(entryId)
    if (entry === null || entry.kind !== 'spend') {
      throw appError('NOT_FOUND', '找不到这笔支出', { detail: `id=${entryId}` })
    }
    if (entry.reversedAt !== null) {
      throw appError('CONFLICT', '这笔支出已经撤销过了', { detail: `id=${entryId}` })
    }
    return rollback(entry, '撤销支出')
  })
}

/* ------------------------------------------------------------------ *
 * 每日任务：streak 口径 + 计分编排（kickoff/11 交付 3–5）
 * ------------------------------------------------------------------ */

/** 这一天按 repeat_rule / active_* 本来该不该有 occurrence（纯规则，不查库） */
function isScheduledDay(task: Task, day: string): boolean {
  if (task.activeFrom !== null && day < task.activeFrom) return false
  if (task.activeTo !== null && day > task.activeTo) return false
  const days = occurrenceService.repeatDaysOf(task.repeatRule)
  return days === null || days.includes(isoWeekday(day))
}

/** 从 occurrence 历史里数出「正好在 endingDay 结束」的连续完成天数 */
function streakFromHistory(
  task: Task,
  history: Map<string, Occurrence['status']>,
  endingDay: string
): number {
  let streak = 0
  for (let i = 0; i < STREAK_SCAN_LIMIT; i += 1) {
    const day = addDays(endingDay, -i)
    if (task.activeFrom !== null && day < task.activeFrom) break
    const status = history.get(day)
    if (status === undefined) {
      // 没有这一天的行：本来就不该做（周几不匹配 / 区间外）→ 不算断，继续往前看；
      // 该做却没生成过行（01 §2.1.3 不回溯生成）→ 视为没做，断开
      if (isScheduledDay(task, day)) break
      continue
    }
    if (status !== 'done') break
    streak += 1
  }
  return streak
}

/**
 * 「正好在 endingDay 结束」的连续天数（公开给测试与撤销用）。
 *
 * 红线 5：streak 只能从 occurrence 历史反查，**不许靠 ±1**——漏做一天后归 1、
 * 撤销第 7 天回 6，两种口径「减 1」都算不出来。
 */
export function streakEndingAt(task: Task, endingDay: string): number {
  const history = new Map(occurrenceRepo.listByTask(task.id).map(o => [o.day, o.status] as const))
  return streakFromHistory(task, history, endingDay)
}

export interface AwardOccurrenceResult {
  occurrence: Occurrence
  entry: PointEntry
  streakAfter: number
  /** 内部形状：handler 用它算真实 changed（not IPC 载荷） */
  taskBefore: Task
  task: Task
}

/**
 * `occurrence.complete`：完成今天这一次（02 §3.2b）。
 *
 * 同一事务内：写 `task_done` 流水（带 `occurrence_id`）→ 命中里程碑再写一条 `streak_bonus`
 * → occurrence 落 done + streak 两列 + `daily_stats`。
 *
 * 里程碑那条的 `occurrence_id` **必须是 NULL**：`uq_ledger_occurrence` 是「每个 occurrence
 * 只准一条」，两条都带同一个 id 会被自己的唯一索引拒掉。
 *
 * 重复完成不做事先判重：第二次会撞 `uq_ledger_occurrence`，翻成 CONFLICT 并整体回滚。
 */
export function awardOccurrence(occurrenceId: string): AwardOccurrenceResult {
  const cfg = pointsConfig()
  return tx(() => {
    const occ = occurrenceRepo.requireById(occurrenceId)
    const taskBefore = taskRepo.requireById(occ.taskId)

    // 先把这一天视为已完成再数 streak：否则第 0 天还停在 pending，streak 恒为 0
    const history = new Map(occurrenceRepo.listByTask(taskBefore.id).map(o => [o.day, o.status] as const))
    history.set(occ.day, 'done')
    const streakAfter = streakFromHistory(taskBefore, history, occ.day)

    const { base, bonus } = computeDailyPoints(streakAfter, cfg)
    const day = occ.day

    const entry = award({
      taskId: taskBefore.id,
      occurrenceId: occ.id,
      delta: base,
      kind: 'award',
      reasonCode: 'task_done',
      reasonText: taskBefore.title,
      day
    })
    if (bonus > 0) {
      award({
        taskId: taskBefore.id,
        occurrenceId: null,
        delta: bonus,
        kind: 'award',
        reasonCode: 'streak_bonus',
        reasonText: taskBefore.title,
        day
      })
    }

    const occurrence = occurrenceService.complete({
      occurrence: occ,
      pointsAwarded: roundPoints(base + bonus),
      completedAt: nowIso(),
      streakAfter
    })
    return {
      occurrence,
      entry,
      streakAfter,
      taskBefore,
      task: taskRepo.requireById(taskBefore.id)
    }
  })
}

/**
 * 这一天已经入账的流水：`task_done` 那条（带 occurrence_id）+ 里程碑那条
 * （`occurrence_id IS NULL` 的 `streak_bonus`，按 task + day 定位）。
 * 已经退回 pending / skipped 的没有可冲销的行。
 */
function entriesOfOccurrence(occ: Occurrence): PointEntry[] {
  if (occ.status !== 'done') return []
  return ledgerRepo
    .list({ from: occ.day, to: occ.day })
    .filter(
      e =>
        // 已冲销的行不能再冲一次：撤销→重做→再撤销时，同一天会同时存在
        // "被冲过的旧行"和"新的有效行"，不过滤就会把余额扣两次（v0.19）
        e.reversedAt === null &&
        (e.occurrenceId === occ.id ||
          (e.occurrenceId === null && e.taskId === occ.taskId && e.reasonCode === 'streak_bonus'))
    )
}

export interface UndoOccurrenceResult {
  occurrence: Occurrence
  balanceAfter: number
  /** 内部形状：handler 用它算真实 changed（not IPC 载荷） */
  taskBefore: Task
  task: Task
}

/**
 * `occurrence.undo`：撤销这一天（02 §3.2b）。
 *
 * 冲销走 `rollback()` 写负流水，**不删行**（流水一旦写入就是事实）；里程碑那条一并冲销。
 * streak 回退到「前一天的真实值」——用 occurrence 反查，不是 -1。
 * `streak_best` 保留历史最高，不跟着回退。
 */
export function undoOccurrence(occurrenceId: string): UndoOccurrenceResult {
  return tx(() => {
    const occ = occurrenceRepo.requireById(occurrenceId)
    const taskBefore = taskRepo.requireById(occ.taskId)

    for (const e of entriesOfOccurrence(occ)) rollback(e, taskBefore.title)

    const streakAfter = streakEndingAt(taskBefore, addDays(occ.day, -1))
    const occurrence = occurrenceService.undo({ occurrence: occ, streakAfter })
    return {
      occurrence,
      balanceAfter: ledgerRepo.balance(),
      taskBefore,
      task: taskRepo.requireById(taskBefore.id)
    }
  })
}

/**
 * `occurrence.skip`：本次跳过，不计分、不动 streak 两列（01 §4）。
 *
 * 已完成的打卡不回退成「跳过」：积分已经入账，先 `undo` 再跳；这里直接原样返回，
 * 不写库也不冲销（隐式冲销等于绕过 ledger 的唯一真相）。
 */
export function skipOccurrence(occurrenceId: string, note?: string): Occurrence {
  return tx(() => {
    const occ = occurrenceRepo.requireById(occurrenceId)
    if (occ.status === 'done') return occ
    return occurrenceService.skip({ occurrence: occ, note })
  })
}
