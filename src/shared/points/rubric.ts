import type { Difficulty, EventResult, Quality, TaskType } from '../types/domain'

/**
 * v0.7（2026-10-28 用户定稿）：时长退出积分公式。
 *
 * 旧版是 `难度基数 × 工作量系数`，系数随预估时长从 1.0 涨到 1.6。问题是时长由用户/AI
 * 自己填，等于"填得越长分越高"——磨洋工可刷分。现在时长只保留两个用途：
 * 1) 作为 AI 判定难度的输入（03-AI-CONTRACT：trivial 的定义就是 ≤10 分钟）；
 * 2) 提醒与逾期判定。
 * 分值只由难度决定，改公式必须同时升这个版本号，历史流水按版本解释。
 */
export const RUBRIC_VERSION = 'v0.7'

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

/** 完成度系数：任务本身做到什么程度 */
export const QUALITY_FACTOR: Record<Quality, number> = {
  partial: 0.6,
  met: 1.0,
  exceeded: 1.15
}

/**
 * 限时任务的完成效率系数：距截止越早越高，封顶 1.2。
 *
 * 用绝对提前量而不是"提前比例"：比例会让"截止日写得越远、立刻做完越赚"，
 * 等于把刚拆掉的时长口子从另一边开回来。分三档、封顶 20%，改动幅度可控。
 *
 * @param leadHours (dueAt - completedAt) / 3600000，负数表示逾期
 */
export function efficiencyFactor(leadHours: number | null): number {
  if (leadHours === null) return 1
  if (leadHours < 24) return 1
  if (leadHours < 72) return 1.1
  return 1.2
}

/** 活动任务的结果系数：考试排名、比赛名次、作品评价 */
export function resultFactor(result: EventResult | null): number {
  if (result === 'exceeded') return 1.2
  if (result === 'below') return 0.85
  return 1
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

/** 应得分：只由难度决定（v0.7 起与时长无关，estimateMin 不再进公式） */
export function computePlannedPoints(d: Difficulty, cfg = DEFAULT_CONFIG): number {
  return clamp(roundPoints(cfg.difficultyBase[d]), 1, 100)
}

export interface AwardInput {
  type: TaskType
  /** 应得分，来自 computePlannedPoints */
  planned: number
  /** 完成度；event 不使用（活动由 result 表达，避免完成度与结果重复计分） */
  quality: Quality
  /** 逾期天数，仅 deadline 参与扣分；event 的日期固定在事前，不按逾期扣 */
  overdueDays: number
  /** 仅 deadline：距截止的小时数，负数=逾期。null/省略=未知，按 1.0 计 */
  leadHours?: number | null
  /** 仅 event：结果档。null/省略=按 met 计 */
  result?: EventResult | null
}

/**
 * 实得分 = 应得分 × 完成度 × 类型系数 − 逾期扣分
 *
 * - 限时：类型系数 = 完成效率（提前 ≥72h → 1.2，≥24h → 1.1，否则 1.0）
 * - 活动：类型系数 = 结果（超预期 1.2 / 达标 1.0 / 不佳 0.85），不看完成度
 * - 每日：不走这里，用 computeDailyPoints
 *
 * 上限 1.4 倍：质量 1.15 × 效率 1.2 = 1.38，留一点冗余；下限 1 分，避免扣成负数。
 */
export function computeAwardedPoints(input: AwardInput): number {
  const { type, planned, quality, overdueDays } = input
  const q = type === 'event' ? 1 : QUALITY_FACTOR[quality]
  const typeCoeff =
    type === 'deadline'
      ? efficiencyFactor(input.leadHours ?? null)
      : type === 'event'
        ? resultFactor(input.result ?? null)
        : 1
  const penalty = type === 'deadline' ? Math.min(overdueDays * 2, 20) : 0
  return clamp(roundPoints(planned * q * typeCoeff - penalty), 1, roundPoints(planned * 1.4))
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
