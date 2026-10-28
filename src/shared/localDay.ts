/**
 * 本地日历日的**唯一**计算处（01 §4.1 的「时区陷阱」）。
 *
 * 规则：所有 `day` 字段（occurrences.day / point_ledger.day / daily_stats.day）都按**本地时区**
 * 算成 `YYYY-MM-DD` 字符串再写入；**禁止**用 SQLite 的 `date('now')` 或 `toISOString().slice(0,10)`
 * ——后者是 UTC 日期，东八区 00:00–08:00 写入会整片串到前一天。
 *
 * 实现用 `Intl.DateTimeFormat` + 显式 timeZone，而不是 `Date#getDate()`：
 * 好处是测试可以钉死 `Asia/Shanghai` 断言（不依赖跑测试那台机器的系统时区），
 * 生产调用不传 timeZone 即系统本地时区，语义与 getDate() 完全一致。
 *
 * v0.20：主进程与三个渲染层模块原本各有一份实现（共 5 份），统一搬到这里。
 * 渲染侧模块用 `export { toLocalDay as localDayOf } from '@shared/localDay'` 保留旧名，
 * 新增代码一律直接用 `toLocalDay`。
 */

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
