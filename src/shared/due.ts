import { toLocalDay } from './localDay'

/**
 * `due_at` 时间线的**唯一**解析处（v0.53）。
 *
 * 三档精度由字符串形状直接判定，不加列、不迁移：
 * - `YYYY-MM-DDTHH:mm…` → `minute`（有真实时刻）
 * - `YYYY-MM-DD`        → `day`（只知道哪天）
 * - `YYYY-MM`           → `month`（只知道哪个月）
 *
 * **禁止在别处再写裸解析**（把 `dueAt` 直接交给 `new Date()` / `Date.parse()`）：`2026-11-05` 被 V8
 * 当成 UTC 零点，东八区拿到 `getHours() = 8`，上午 9 点就判逾期。`day` / `month` 的「截止瞬间」
 * 必须按**本地日历**归一到当天 / 月末的 23:59:59.999（见 `dueInstant`），而 `due_at` 存的原串一个字都不改。
 *
 * 纯函数：不 import 主进程 / 渲染层任何模块（两边都用），只依赖同样是纯函数的 `localDay`。
 */

export type DuePrecision = 'minute' | 'day' | 'month'

const MINUTE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_SHAPE = /^(\d{4})-(\d{2})$/

function isMonthNumber(month: number): boolean {
  return Number.isInteger(month) && month >= 1 && month <= 12
}

/** 该年该月的天数；月份非法返回 0。按真实日历算，不写死 30/31 */
function daysInMonth(year: number, month: number): number {
  if (!isMonthNumber(month)) return 0
  return new Date(year, month, 0).getDate()
}

/** 年-月-日 是否为真实存在的一天（`2026-02-30` / `2026-13-01` 都要否掉） */
function isCalendarDay(year: number, month: number, day: number): boolean {
  if (!isMonthNumber(month)) return false
  if (!Number.isInteger(day) || day < 1) return false
  return day <= daysInMonth(year, month)
}

/** 形状 + 合法性判定；非法一律 `null`（不抛错、不猜） */
export function duePrecisionOf(raw: string | null | undefined): DuePrecision | null {
  if (typeof raw !== 'string' || raw.length === 0) return null

  const minute = MINUTE_SHAPE.exec(raw)
  if (minute) {
    if (!isCalendarDay(Number(minute[1]), Number(minute[2]), Number(minute[3]))) return null
    // 时分是否越界（T99:99）交给 Date：ISO8601 的越界时刻解析结果为 NaN
    return Number.isNaN(new Date(raw).getTime()) ? null : 'minute'
  }

  const day = DAY_SHAPE.exec(raw)
  if (day) return isCalendarDay(Number(day[1]), Number(day[2]), Number(day[3])) ? 'day' : null

  const month = MONTH_SHAPE.exec(raw)
  if (month) return isMonthNumber(Number(month[2])) ? 'month' : null

  return null
}

/**
 * 「截止瞬间」：只用于计算，**不回写 `due_at`**。
 *
 * - `minute` → 原样解析
 * - `day`    → 当天 23:59:59.999（本地）
 * - `month`  → 当月最后一天 23:59:59.999（本地）
 */
export function dueInstant(raw: string | null | undefined): Date | null {
  const precision = duePrecisionOf(raw)
  if (precision === null) return null
  const value = raw as string

  if (precision === 'minute') {
    const at = new Date(value)
    return Number.isNaN(at.getTime()) ? null : at
  }

  const [year, month, day] = value.split('-').map(Number)
  if (precision === 'day') return new Date(year, month - 1, day, 23, 59, 59, 999)
  // month：下个月的第 0 天 = 本月最后一天
  return new Date(year, month, 0, 23, 59, 59, 999)
}

/**
 * 截止日的本地 `YYYY-MM-DD`：`month` → 月末那天，`day` → 原串前 10 位。
 *
 * `day` 精度**不走 Date**：那个串本身就是本地日历日，转一道 Date 会在西半球串到前一天。
 */
export function dueLocalDay(
  raw: string | null | undefined,
  timeZone?: string
): string | null {
  const precision = duePrecisionOf(raw)
  if (precision === null) return null
  const value = raw as string

  if (precision === 'day') return value.slice(0, 10)
  if (precision === 'month') {
    const [year, month] = value.split('-').map(Number)
    return `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`
  }

  return toLocalDay(new Date(value), timeZone)
}

/** 有没有真实时刻（只有 `minute` 精度有） */
export function dueHasTime(raw: string | null | undefined): boolean {
  return duePrecisionOf(raw) === 'minute'
}
