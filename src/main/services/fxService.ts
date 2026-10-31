import type { FxRate } from '../../shared/types/domain'
import { broadcast } from '../bus'
import { addDays, isoWeekday, nowIso, toLocalDay } from '../db/localDay'
import { isConstraintError } from '../db/errors'
import { newId } from '../db/ids'
import * as fxRepo from '../db/repositories/fxRepo'
import { evaluateFx } from '../ai/pipelines/fx'

/**
 * 汇率服务（v0.45，45 §5.2）。
 *
 * 一句话：1 积分值多少元，每周一由 AI 按上周表现小幅调整，区间 0.85 ~ 1.15。
 *
 * 三条纪律：
 * 1. `currentRate()` **永不抛错**——记账不该因为汇率表是空的而失败，缺了就按 1.0 算。
 * 2. `ensureWeek()` 幂等：本周已有记录就什么都不做；失败也要落一行 fallback，
 *    这样本周不会再重试，sweeper 不会每 30 分钟烧一次钱。
 * 3. 失败沿用**上期**汇率，不许回落成 1.0——那等于把攒下的升幅一次抹平。
 *
 * 导入纪律：本文件**不在顶层 import `./aiService`**（`aiService → pointsService → fxService`
 * 已成链，反向顶层 import 会成环），需要 provider 时在函数内动态取。
 */

export interface FxCurrent {
  rate: number
  /** 生效的那一周的周一（本地日）；表空时是本周一 */
  weekStart: string
}

/** 基准汇率：1 积分 = 1 元（45 §1 裁决 1） */
const BASE_RATE = 1

/** 某一天所在周的周一（本地日） */
export function weekStartOf(day: string): string {
  return addDays(day, -(isoWeekday(day) - 1))
}

/**
 * 当期汇率：本周有记录用它；没有就用最近一条；一条都没有按 1.0。
 * `weekStart` 返回的是**那条记录自己的**周，不是本周——调用方拿它只做展示/透传。
 */
export function currentRate(): FxCurrent {
  const thisWeek = weekStartOf(toLocalDay(new Date()))
  const weekly = fxRepo.byWeek(thisWeek)
  if (weekly !== null) return { rate: weekly.rate, weekStart: weekly.weekStart }
  const recent = fxRepo.latest()
  if (recent !== null) return { rate: recent.rate, weekStart: recent.weekStart }
  return { rate: BASE_RATE, weekStart: thisWeek }
}

/**
 * 保证本周有一期汇率（幂等，供 `fxSweeper` 与测试调用）。
 *
 * 顺序照 45 §5.2：
 * 1. AI 未配置 → fallback（不花请求）；
 * 2. 上周一条可看的数据都没有（tasks_done / occurrences_done / missed 合计为 0）→ fallback，**不调 AI**；
 * 3. 否则请 AI 评估，任何失败也写 fallback。
 */
export async function ensureWeek(now: Date = new Date()): Promise<FxRate> {
  const weekStart = weekStartOf(toLocalDay(now))
  const existing = fxRepo.byWeek(weekStart)
  if (existing !== null) return existing

  // 上期汇率：本周之前的最近一条（可能不是"上一周"，比如中间几周没开过机）
  const previous = fxRepo.latest()
  const carry = previous === null ? BASE_RATE : previous.rate

  const lastFrom = addDays(weekStart, -7)
  const lastTo = addDays(weekStart, -1)
  const snapshot = fxRepo.weekSnapshot(lastFrom, lastTo)
  const activity =
    snapshot.days.reduce((sum, day) => sum + day.tasksDone + day.occurrencesDone, 0) +
    snapshot.missedTasks

  // 动态取 aiService：避免与 pointsService 形成顶层环（见文件头）
  const ai = await import('./aiService')

  let rate = carry
  let source: FxRate['source'] = 'fallback'
  let basis = ''

  if (ai.keyStatus().configured && activity > 0) {
    try {
      const evaluated = await evaluateFx({
        provider: ai.backgroundProvider(),
        weekStart: lastFrom,
        days: snapshot.days,
        missedTasks: snapshot.missedTasks
      })
      rate = evaluated.rate
      source = 'ai'
      basis = evaluated.reason
      // basis 只进库；这里留一条不含用户可见文案的调试线索
      console.info(`[fx] 本期汇率 ${rate}`, basis)
    } catch (e) {
      // 超时 / 上游错 / 输出不合法：沿用上期，本周不再重试
      console.warn('[fx] 评估失败，沿用上期汇率', e)
    }
  }

  const createdAt = nowIso()
  try {
    fxRepo.insert({ id: newId(), weekStart, rate, basis, source, createdAt })
  } catch (e) {
    // 并发下另一个进程/另一轮 sweeper 已经写了：当作"本期已有"，不重复广播
    if (!isConstraintError(e)) throw e
    const raced = fxRepo.byWeek(weekStart)
    if (raced !== null) return raced
    throw e
  }

  broadcast({ type: 'fx.changed', rate, weekStart })
  return { weekStart, rate, source, createdAt }
}
