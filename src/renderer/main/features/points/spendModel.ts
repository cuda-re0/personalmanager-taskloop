import { fmtMoney, fmtPoints } from '@shared/format'
import { MAX_SPEND_CENTS, MONTHLY_BUDGET_CENTS } from '@shared/points/spend'
import { localDayOf, shiftDay, timeLabel } from './pointsModel'

/**
 * 支出页的纯模型（v0.45，45 §7.1）。导出只为可测：组件里不再写解析与格式化。
 *
 * 纪律：本文件**不算分也不算钱**——金额的换算只在 `parseAmountToCents`（分）与
 * `fmtMoney`（显示）两处发生，汇率由主进程给。
 */

/** ④ 的第五个标签（04 §1.4 登记的固定文字） */
export const SPEND_VIEW_LABEL = '支出'

/**
 * 金额输入 → 整数「分」。不合法一律 `null`（按钮据此禁用）。
 *
 * **全程字符串拆解，禁止浮点**：把元当浮点乘 100，会得到 1250.0000000000002 这种数，
 * 这类误差一旦进库，余额和"已花 / 500"就再也对不平。
 * 范围 `0 < cents <= MAX_SPEND_CENTS`：0 与负数不能记，1000.01 元超单笔上限。
 */
export function parseAmountToCents(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null
  const [intPart, fracPart = ''] = text.split('.')
  const cents = parseInt(intPart, 10) * 100 + parseInt(fracPart.padEnd(2, '0'), 10)
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_SPEND_CENTS) return null
  return cents
}

export interface SpendHeaderParts {
  /** `10 月 · 1 分 = 1.08 元 · ` */
  prefix: string
  /** `已花 128 / 500` —— 超预算时**只有这一段**变红 */
  spent: string
}

/**
 * 顶部那一行拆成两段：45 §7.2 要求超预算时只把「已花…」变红，
 * 拆不开就只能整行染色，与规格不符。
 */
export function spendHeaderParts(
  month: number,
  rate: number,
  spentCents: number
): SpendHeaderParts {
  return {
    prefix: `${month} 月 · 1 分 = ${fmtPoints(rate)} 元 · `,
    spent: `已花 ${fmtMoney(spentCents)} / ${fmtMoney(MONTHLY_BUDGET_CENTS)}`
  }
}

/** 整行文本（= prefix + spent）；测试与可访问性用 */
export function spendHeaderText(month: number, rate: number, spentCents: number): string {
  const parts = spendHeaderParts(month, rate, spentCents)
  return parts.prefix + parts.spent
}

/** 超预算：严格大于月预算（正好花完 500 不算超） */
export function isOverBudget(spentCents: number): boolean {
  return spentCents > MONTHLY_BUDGET_CENTS
}

/**
 * 今天（本地日）。
 *
 * 组件里不许出现 `new Date`——points 目录的 .tsx 有一条守卫用例盯着日期算术，
 * 日期一律由纯模型给（与 `ledgerModel` 同一口径）。
 */
export function spendToday(now: Date = new Date()): string {
  return localDayOf(now)
}

/**
 * 支出行的时间标签：今天 `HH:mm`、昨天 `昨天 HH:mm`、更早 `M月D日 HH:mm`。
 * 日期换算复用 `pointsModel`（`localDayOf` / `shiftDay` / `timeLabel`），不另造一套。
 */
export function spendTimeLabel(iso: string, today: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const time = timeLabel(iso)
  const day = localDayOf(parsed)
  if (day === today) return time
  if (day === shiftDay(today, -1)) return `昨天 ${time}`
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${time}`
}
