import type { Difficulty, Quality } from '../types/domain'

/** v0.6：B 档额度 + 小数积分。改公式必须同时改这里，历史流水按版本解释 */
export const RUBRIC_VERSION = 'v0.6-b'

export interface PointsConfig {
  difficultyBase: Record<Difficulty, number>
  dailyBase: number // 每日任务单日基础分
  streakBonus: { days: number; bonus: number }[] // 连续里程碑
  dailyCap: number | null // 日上限，null=不限
}

export const DEFAULT_CONFIG: PointsConfig = {
  difficultyBase: { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  dailyBase: 1,
  streakBonus: [
    { days: 7, bonus: 5 },
    { days: 30, bonus: 20 }
  ],
  dailyCap: null
}

/** 工作量系数：0 min → 1.0，≥240 min → 1.6，线性 */
export function effortFactor(estimateMin: number | null): number {
  const m = Math.min(Math.max(estimateMin ?? 0, 0), 240)
  return 1 + (m / 240) * 0.6
}

/**
 * 统一精度：保留 2 位小数。
 * 不是为了"取整好看"，而是浮点乘除会累积误差（5.750000000000001），
 * 不收敛的话余额 SUM 几十次之后会出现 319.99999999999994 这种数。
 * 除这一个函数外，全项目任何地方都不许再对积分做 round / toFixed。
 */
export function roundPoints(v: number): number {
  return Math.round(v * 100) / 100
}

/** 应得分。不取整：5 分档在 60 分钟时是 5.75，与 5 分有可见差别 */
export function computePlannedPoints(
  d: Difficulty,
  estimateMin: number | null,
  cfg = DEFAULT_CONFIG
): number {
  const raw = cfg.difficultyBase[d] * effortFactor(estimateMin)
  return clamp(roundPoints(raw), 1, 100)
}

export function computeAwardedPoints(planned: number, quality: Quality, overdueDays: number): number {
  const q = { partial: 0.6, met: 1.0, exceeded: 1.15 }[quality]
  const penalty = Math.min(overdueDays * 2, 20)
  return clamp(roundPoints(planned * q - penalty), 1, roundPoints(planned * 1.2))
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi)
}

/** 完成某一天这一次；返回基础分 + 若达成里程碑则附带的奖励 */
export function computeDailyPoints(
  streakAfter: number,
  cfg = DEFAULT_CONFIG
): { base: number; bonus: number; milestoneReached: number | null } {
  const base = cfg.dailyBase
  const hit = cfg.streakBonus.find(m => m.days === streakAfter) ?? null
  return { base, bonus: hit?.bonus ?? 0, milestoneReached: hit?.days ?? null }
}
