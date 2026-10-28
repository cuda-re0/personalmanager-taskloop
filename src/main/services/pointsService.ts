import type { PointEntry } from '../../shared/types/domain'
import type { PointsConfig } from '../../shared/points/rubric'
import { computeDailyPoints, computePlannedPoints, roundPoints } from '../../shared/points/rubric'
import type { DayStat, Difficulty, TaskType } from '../../shared/types/domain'
import { tx } from '../db/connection'
import { appError } from '../db/errors'
import { nowIso, todayLocalDay } from '../db/localDay'
import { newId } from '../db/ids'
import * as ledgerRepo from '../db/repositories/ledgerRepo'
import * as settingRepo from '../db/repositories/settingRepo'
import * as statsRepo from '../db/repositories/statsRepo'

/**
 * pointsService —— 积分的数据访问 + 精度收敛（01 §2.4 / 02 §5）。
 *
 * 边界：**不发分、不判质量**。谁该得多少分由 W6 依 rubric 算好后传给 `award()`，
 * 本文件只保证「写流水 + 更新 daily_stats 在同一事务里」和「写入前过 roundPoints」。
 *
 * 精度纪律（08 DELTA · D1）：`roundPoints` 是**全项目唯一**的取整点（在 rubric.ts 里），
 * 本文件只调用它，不出现 `Math.round` / `toFixed`。
 */

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

/** settings['points.*'] → rubric 的配置对象（02 §5.1） */
export function pointsConfig(): PointsConfig {
  return {
    difficultyBase: settingRepo.get('points.difficultyBase'),
    dailyBase: settingRepo.get('points.dailyBase'),
    streakBonus: settingRepo.get('points.streakBonus'),
    dailyCap: settingRepo.get('points.dailyCap')
  }
}

/** `points.preview`：纯计算、无副作用。daily 返回的是**单日**分值。 */
export function previewPoints(
  type: TaskType,
  difficulty: Difficulty,
  estimateMin: number | null
): number {
  const cfg = pointsConfig()
  if (type === 'daily') return roundPoints(cfg.dailyBase)
  return computePlannedPoints(difficulty, estimateMin, cfg)
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
 * 撤销（`occurrence.undo` / `task` 的 24h 内撤销）写一条负流水冲销。
 *
 * 关键点：冲销行**必须** `occurrence_id = NULL` 且 `reason_code` 不是 `task_done`，
 * 否则会撞两条条件唯一索引（它们是"每个任务/每个 occurrence 只准一条"）。
 * 所以冲销统一记成 `manual_adjust`，原单号写进 reason_text 便于对账。
 */
export function rollback(entry: PointEntry, reasonText: string): PointEntry {
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
