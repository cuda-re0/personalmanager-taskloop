import { appError } from './errors'

/**
 * 本地日历日的唯一计算处（01 §4.1 的「时区陷阱」）。
 *
 * 规则：所有 `day` 字段（occurrences.day / point_ledger.day / daily_stats.day）都按**本地时区**
 * 算成 `YYYY-MM-DD` 字符串再写入；**禁止**用 SQLite 的 `date('now')` 或 `toISOString().slice(0,10)`
 * ——后者是 UTC 日期，东八区 00:00–08:00 写入会整片串到前一天。
 *
 * 实现用 `Intl.DateTimeFormat` + 显式 timeZone，而不是 `Date#getDate()`：
 * 好处是测试可以钉死 `Asia/Shanghai` 断言（不依赖跑测试那台机器的系统时区），
 * 生产调用不传 timeZone 即系统本地时区，语义与 getDate() 完全一致。
 */

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const timeFormatters = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let f = dayFormatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    dayFormatters.set(key, f)
  }
  return f
}

function timeFormatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let f = timeFormatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    timeFormatters.set(key, f)
  }
  return f
}

function partOf(parts: Intl.DateTimeFormatPart[], type: string): string {
  for (const p of parts) if (p.type === type) return p.value
  return ''
}

/** Date → 本地日历日 `YYYY-MM-DD`。timeZone 只给测试用，生产不传。 */
export function toLocalDay(d: Date, timeZone?: string): string {
  const parts = dayFormatter(timeZone).formatToParts(d)
  return `${partOf(parts, 'year')}-${partOf(parts, 'month')}-${partOf(parts, 'day')}`
}

/** ISO8601 UTC 字符串 → 本地日历日 */
export function isoToLocalDay(iso: string, timeZone?: string): string {
  return toLocalDay(new Date(iso), timeZone)
}

/** 当前本地日历日 */
export function todayLocalDay(timeZone?: string): string {
  return toLocalDay(new Date(), timeZone)
}

/** ISO8601 UTC 字符串 → 本地时刻 `HH:mm`（日历 dayDetail 用） */
export function isoToLocalTime(iso: string, timeZone?: string): string {
  const parts = timeFormatter(timeZone).formatToParts(new Date(iso))
  return `${partOf(parts, 'hour')}:${partOf(parts, 'minute')}`
}

/** 写入用时间戳：一律 ISO8601 UTC（01 抬头约定） */
export function nowIso(): string {
  return new Date().toISOString()
}

export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const [y, m, d] = day.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * 校验 `YYYY-MM-DD`。`label` 是会被 UI 直接渲染的中文日期字段名
 * （04 §1.1 登记的文案：「{日期字段} 必须是 YYYY-MM-DD 格式的本地日期」），
 * 所以默认值和调用点都不许传英文，否则用户看到「from 必须是 …」。
 */
export function assertDay(day: string, label = '日期'): string {
  if (!isValidDay(day)) {
    throw appError('INVALID_INPUT', `${label} 必须是 YYYY-MM-DD 格式的本地日期`, {
      detail: `收到 ${JSON.stringify(day)}`
    })
  }
  return day
}

/** 纯日历运算的内部表示（UTC），不受夏令时影响 */
export function dayToUtcDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function utcDateToDay(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

export function addDays(day: string, n: number): string {
  const dt = dayToUtcDate(day)
  dt.setUTCDate(dt.getUTCDate() + n)
  return utcDateToDay(dt)
}

/** 加月，月末溢出向回夹（01-31 +1 月 → 02-28/29），避免算出 06-31 这种非法日 */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const targetMonthIndex = m - 1 + n
  // 月份整除（目标年月），不产出积分值，属"日期整除"例外；取整禁令只针对分值（02 §5.2）
  const year = y + Math.floor(targetMonthIndex / 12)
  const month = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return `${year}-${pad2(month + 1)}-${pad2(Math.min(d, lastDay))}`
}

/** 相差天数（b - a）。两端都是 UTC 午夜，差值恒为 86400000 的整数倍，直接相除即可 */
export function dayDiff(a: string, b: string): number {
  return (dayToUtcDate(b).getTime() - dayToUtcDate(a).getTime()) / 86400000
}

/** ISO 周几：1=周一 … 7=周日（`WEEKLY:1,3,5` 的 1 就是周一） */
export function isoWeekday(day: string): number {
  const dow = dayToUtcDate(day).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** [from, to] 闭区间的每一天 */
export function daysBetweenInclusive(from: string, to: string): string[] {
  const out: string[] = []
  const total = dayDiff(from, to)
  for (let i = 0; i <= total; i += 1) out.push(addDays(from, i))
  return out
}

/** 某月 1 号与该月最后一天（日历查询用） */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${pad2(month)}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from, to: `${year}-${pad2(month)}-${pad2(lastDay)}` }
}
