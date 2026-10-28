import type { Occurrence, Task } from '../../shared/types/domain'
import { tx } from './connection'
import { addMonths, assertDay, daysBetweenInclusive, isoWeekday, nowIso, todayLocalDay } from './localDay'
import { appError } from './errors'
import * as occurrenceRepo from './repositories/occurrenceRepo'
import * as statsRepo from './repositories/statsRepo'
import * as taskRepo from './repositories/taskRepo'

/**
 * 每日任务的 occurrence 生成（01 §2.1.3）。
 *
 * 三条硬约束：
 * 1. **不回溯**：起点被夹到「今天」，`from` 早于今天也不会补过去日期（避免历史被伪造）。
 * 2. **不越界**：终点被夹到 `active_to` 与「今天 + 3 个月」。
 * 3. **幂等**：靠 `uq_occurrence_task_day` + `INSERT OR IGNORE`，连续调用 N 次数量不增长。
 *
 * 另：`repeat_rule` 决定这天要不要有 occurrence（`'DAILY'` / `NULL` = 每天，
 * `'WEEKLY:1,3,5'` = 只在周一/三/五，1=周一）。01 §2.1.3 的生成规则里没写这条，
 * 但不按它过滤会给"每周三次"的任务生成 7 条 → 直接污染 streak 与日历，故按字段语义实现（已在交付说明里报告）。
 */

export const OCCURRENCE_HORIZON_MONTHS = 3

export interface EnsureRangeResult {
  created: number
  scannedTasks: number
  range: { from: string; to: string }
}

/** `null` / `'DAILY'` → 每天；`'WEEKLY:1,3,5'` → 指定 ISO 周几 */
export function repeatDaysOf(repeatRule: string | null): number[] | null {
  if (repeatRule === null || repeatRule === '' || repeatRule.toUpperCase() === 'DAILY') return null
  const match = /^WEEKLY:([1-7](?:,[1-7])*)$/i.exec(repeatRule.trim())
  if (!match) {
    throw appError('INVALID_INPUT', '重复规则格式不正确', {
      detail: `期望 'DAILY' 或 'WEEKLY:1,3,5'，收到 ${JSON.stringify(repeatRule)}`
    })
  }
  return match[1].split(',').map(Number)
}

function matchesRepeat(repeatRule: string | null, day: string): boolean {
  const days = repeatDaysOf(repeatRule)
  if (days === null) return true
  return days.includes(isoWeekday(day))
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b
}

function minDay(a: string, b: string): string {
  return a < b ? a : b
}

/**
 * 幂等补齐 `[from, to]` 内的 occurrence。
 * 会先把区间夹到「今天 ~ min(to, active_to, 今天+3个月)」，夹完为空则什么都不做。
 */
export function ensureRange(from: string, to: string): EnsureRangeResult {
  assertDay(from, '起始日')
  assertDay(to, '结束日')

  const today = todayLocalDay()
  const horizon = addMonths(today, OCCURRENCE_HORIZON_MONTHS)
  const start = maxDay(from, today)
  const end = minDay(to, horizon)

  if (start > end) return { created: 0, scannedTasks: 0, range: { from: start, to: end } }

  const dailyTasks = taskRepo.listDailyActive()
  const createdAt = nowIso()
  let created = 0

  tx(() => {
    for (const task of dailyTasks) {
      const lower = maxDay(start, task.activeFrom ?? start)
      const upper = minDay(end, task.activeTo ?? end)
      if (lower > upper) continue
      for (const day of daysBetweenInclusive(lower, upper)) {
        if (!matchesRepeat(task.repeatRule, day)) continue
        if (occurrenceRepo.insertIfAbsent(task.id, day, createdAt)) created += 1
      }
    }
  })

  return { created, scannedTasks: dailyTasks.length, range: { from: start, to: end } }
}

/** 今天这一天的 occurrence（有缺口会先补齐） */
export function listToday(): Occurrence[] {
  const today = todayLocalDay()
  ensureRange(today, today)
  return occurrenceRepo.listByDay(today)
}

/** 日历用：补齐缺口后按区间返回 */
export function listRange(from: string, to: string): Occurrence[] {
  ensureRange(from, to)
  return occurrenceRepo.listByRange(from, to)
}

/** 只读，不触发生成（统计与重建用） */
export function listRangeRaw(from: string, to: string): Occurrence[] {
  return occurrenceRepo.listByRange(from, to)
}

/** 昨天及更早的 pending → missed（供 W8 的 00:05 调度器调用，数据层只做批量写） */
export function markMissedBefore(day: string): number {
  assertDay(day)
  return occurrenceRepo.markMissedBefore(day, nowIso())
}

/* ------------------------------------------------------------------ *
 * 完成 / 撤销 / 跳过（W6，kickoff/11 交付 3–5）
 *
 * 三个函数的边界：**只写 occurrence 与它带出来的任务列**，不碰积分、不判分。
 * 分值计算、ledger 写入与 streak 口径都在 pointsService（services 层）；
 * 本层收的是「已经算好要写什么」。事务由调用方开（pointsService.awardOccurrence 等）。
 * ------------------------------------------------------------------ */

export interface CompleteOccurrenceInput {
  occurrence: Occurrence
  /** 单日实得（基础分 + 里程碑奖励，已过 roundPoints） */
  pointsAwarded: number
  completedAt: string
  /** 这一天完成后的连续天数，由 pointsService 从 occurrence 历史反查 */
  streakAfter: number
}

/**
 * 把这一天标记为已完成：写 occurrence 三列 + 任务的 streak 列 + 当日 occurrences_done。
 * `streak_best` 只增不减（01 §2.1 的列语义）；`streak_current` 用调用方算出的真实值，
 * 不在本层做 ±1。
 */
export function complete(input: CompleteOccurrenceInput): Occurrence {
  return tx(() => {
    const occurrence = occurrenceRepo.update(
      input.occurrence.id,
      {
        status: 'done',
        pointsAwarded: input.pointsAwarded,
        completedAt: input.completedAt
      },
      input.completedAt
    )
    const task = taskRepo.requireById(occurrence.taskId)
    taskRepo.updateColumns(
      task.id,
      {
        streak_current: input.streakAfter,
        streak_best: Math.max(task.streakBest, input.streakAfter)
      },
      input.completedAt
    )
    // 01 §2.6：occurrences_done 与 occurrence 状态同事务（重建口径 = COUNT(status='done')）
    statsRepo.bumpOccurrencesDone(occurrence.day)
    return occurrence
  })
}

export interface UndoOccurrenceInput {
  occurrence: Occurrence
  /** 回退后的连续天数（前一天的真实值），同样由 pointsService 反查 */
  streakAfter: number
}

/**
 * 撤销这一天：退回 `pending`、清掉分值快照与完成时刻。
 * **不写流水**——冲销由 pointsService 走 `rollback()` 写负行，本层不删行也不改 ledger。
 * `streak_current` 写回调用方算好的值；`streak_best` 保留历史最高。
 */
export function undo(input: UndoOccurrenceInput): Occurrence {
  return tx(() => {
    const occurrence = occurrenceRepo.update(
      input.occurrence.id,
      { status: 'pending', pointsAwarded: null, completedAt: null },
      nowIso()
    )
    const task = taskRepo.requireById(occurrence.taskId)
    taskRepo.updateColumns(task.id, { streak_current: input.streakAfter }, nowIso())
    // 只有原本是 done 的那一天才从当日完成数里减回来
    if (input.occurrence.status === 'done') statsRepo.bumpOccurrencesDone(occurrence.day, -1)
    return occurrence
  })
}

export interface SkipOccurrenceInput {
  occurrence: Occurrence
  note?: string | null
}

/**
 * 本次跳过（01 §4 / 02 §3.2b）：不计分、不写 ledger、不动 streak 两列。
 * streak 是「从 occurrence 历史数出来的」，跳过的那天不是 done，下一次完成自然从 1 开始，
 * 所以这里只改 occurrence 自己的状态。
 */
export function skip(input: SkipOccurrenceInput): Occurrence {
  return tx(() => {
    const patch: occurrenceRepo.OccurrenceUpdate = {
      status: 'skipped',
      pointsAwarded: null,
      completedAt: null
    }
    if (input.note !== undefined) patch.note = input.note
    return occurrenceRepo.update(input.occurrence.id, patch, nowIso())
  })
}

/** 某个任务应当出现在哪些天（调试与测试用） */
export function plannedDays(task: Task, from: string, to: string): string[] {
  const lower = maxDay(from, task.activeFrom ?? from)
  const upper = minDay(to, task.activeTo ?? to)
  if (lower > upper) return []
  return daysBetweenInclusive(lower, upper).filter(day => matchesRepeat(task.repeatRule, day))
}
