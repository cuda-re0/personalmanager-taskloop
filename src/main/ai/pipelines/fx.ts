import { z } from 'zod'
import type { DayStat } from '../../../shared/types/domain'
import { RATE_MAX, RATE_MIN } from '../../../shared/points/spend'
import { roundPoints } from '../../../shared/points/rubric'
import { appError } from '../../db/errors'
import { FX_SYSTEM } from '../prompts'
import type { AiProvider } from '../provider'

/**
 * 汇率评估管线（v0.45，45 §5.3）：上周数据 → 本期汇率。
 *
 * 三件事只在这里做，`fxService` 不再重复：
 * 1. schema 是唯一闸门（模型输出是不可信输入）；
 * 2. **钳制分两步、顺序不能换**：先判非法值（当作评估失败抛出去，让上层落 fallback），
 *    再 clamp 到 [0.85, 1.15] 并收敛两位小数；
 * 3. **没有「相对上期最多变动 X」这一层**：区间本身已经收住了，再叠一层平滑
 *    等于把"做得好就升值"变成"每周最多涨一点"，用户看不懂也感受不到。
 */

const fxSchema = z.object({
  rate: z.number(),
  reason: z.string().max(200)
})

export type FxEvalResult = { rate: number; reason: string }

export interface FxEvalInput {
  provider: AiProvider
  /** 上周一（本地日），只用于让模型知道自己在看哪一周 */
  weekStart: string
  days: DayStat[]
  missedTasks: number
}

/** 只把模型判断需要的东西塞进去：points 用原值，不做任何格式化 */
export function buildFxPayload(input: FxEvalInput): string {
  const days = input.days.map(day => ({
    day: day.day,
    points: day.points,
    tasks_done: day.tasksDone,
    occurrences_done: day.occurrencesDone
  }))
  return JSON.stringify({ week_start: input.weekStart, days, missed: input.missedTasks })
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * 评估一次。失败一律**抛**（超时 / 上游错 / 输出不合法 / 数值不可用），
 * 由 `fxService.ensureWeek` 兜成 fallback——本函数不自己决定"沿用上期"，
 * 因为它不知道上期是多少。
 */
export async function evaluateFx(input: FxEvalInput): Promise<FxEvalResult> {
  const { data } = await input.provider.chatJson({
    messages: [
      { role: 'system', content: FX_SYSTEM },
      { role: 'user', content: buildFxPayload(input) }
    ],
    schema: fxSchema,
    temperature: 0
  })

  // 第一步：非法值就是评估失败，不许拿它去 clamp（clamp(NaN) 仍是 NaN，会写进库）
  if (!Number.isFinite(data.rate) || data.rate <= 0) {
    throw appError('AI_PARSE_FAILED', '汇率评估结果不可用', {
      detail: `rate=${String(data.rate)}`
    })
  }

  // 第二步：收进区间并收敛两位小数
  const rate = roundPoints(clamp(data.rate, RATE_MIN, RATE_MAX))
  return { rate, reason: data.reason }
}
