/**
 * 重复规则（v0.76）：只认一种语法 `EVERY:<n>:<unit>[:<selector>]`。
 *
 * 零运行时依赖：日期算术全部走 UTC 午夜的纯整数运算，`day` / `anchor` 都当本地
 * 日历日字符串看待，不引 db 层、不引 electron、不引 react。
 */

export type RepeatUnit = 'D' | 'W' | 'M' | 'Y'

export interface RepeatRule {
  n: number
  unit: RepeatUnit
  weekdays: number[] // W 用，1..7 ISO；其余 []
  monthDays: number[] // M 用，1..31；空数组表示「用锚点当天的号」
  monthDay: string | null // Y 用，'MM-DD'；null 表示「用锚点的月日」
}

const MAX_N: Record<RepeatUnit, number> = { D: 365, W: 52, M: 24, Y: 10 }
const WEEKDAY_CHAR = ['一', '二', '三', '四', '五', '六', '日']
const DAY_MS = 86400000

function fail(): never {
  throw new Error('重复规则格式不正确')
}

function isUnit(s: string): s is RepeatUnit {
  return s === 'D' || s === 'W' || s === 'M' || s === 'Y'
}

/** 本地日历日 → UTC 午夜毫秒数。只用来做差，不参与展示，故不受时区影响 */
function utc(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function isoWeekday(day: string): number {
  const dow = new Date(utc(day)).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** month 为 1..12；Date.UTC(year, month, 0) = 该月最后一天 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function parseList(text: string, min: number, max: number): number[] {
  const out: number[] = []
  for (const part of text.split(',')) {
    if (!/^\d+$/.test(part)) fail()
    const value = Number(part)
    if (value < min || value > max) fail()
    out.push(value)
  }
  return uniqueSorted(out)
}

/** 旧值只在读入时兼容，本模块任何写出路径都不产 DAILY / WEEKLY: */
function normalize(rule: string | null): string {
  const s = (rule ?? '').trim().toUpperCase()
  if (s === '' || s === 'DAILY') return 'EVERY:1:D'
  if (s.startsWith('WEEKLY:')) return `EVERY:1:W:${s.slice('WEEKLY:'.length)}`
  return s
}

export function parseRepeatRule(rule: string | null): RepeatRule {
  const parts = normalize(rule).split(':')
  if (parts.length < 3 || parts.length > 4) fail()
  if (parts[0] !== 'EVERY') fail()
  if (!/^\d+$/.test(parts[1])) fail()

  const unitText = parts[2]
  if (!isUnit(unitText)) fail()
  const unit: RepeatUnit = unitText
  const n = Number(parts[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_N[unit]) fail()

  const base: RepeatRule = { n, unit, weekdays: [], monthDays: [], monthDay: null }
  const selector = parts.length === 4 ? parts[3] : undefined

  if (unit === 'D') {
    if (selector !== undefined) fail()
    return base
  }
  if (unit === 'W') {
    if (selector === undefined || selector === '') fail()
    return { ...base, weekdays: parseList(selector, 1, 7) }
  }
  if (unit === 'M') {
    if (selector === undefined || selector === '') return base
    return { ...base, monthDays: parseList(selector, 1, 31) }
  }

  if (selector === undefined || selector === '') return base
  const match = /^(\d{2})-(\d{2})$/.exec(selector)
  if (match === null) fail()
  const month = Number(match[1])
  const date = Number(match[2])
  // 用闰年（2000）作基准判合法：02-29 可填，04-31 / 13-01 不可填
  if (month < 1 || month > 12 || date < 1 || date > lastDayOfMonth(2000, month)) fail()
  return { ...base, monthDay: selector }
}

export function serializeRepeatRule(r: RepeatRule): string {
  const head = `EVERY:${r.n}:${r.unit}`
  if (r.unit === 'D') return head
  if (r.unit === 'W') return `${head}:${uniqueSorted(r.weekdays).join(',')}`
  if (r.unit === 'M') {
    return r.monthDays.length === 0 ? `${head}:` : `${head}:${uniqueSorted(r.monthDays).join(',')}`
  }
  return r.monthDay === null ? `${head}:` : `${head}:${r.monthDay}`
}

/**
 * `anchor` 是这一系列重复的起算日；锚点之前的日期一律不算，不向前补算。
 * M 的短月补齐：指定的号大于当月天数时，由当月最后一天命中。
 * Y 的 02-29 在平年由 02-28 命中。
 */
export function matchesRepeatDay(rule: string | null, day: string, anchor: string): boolean {
  const r = parseRepeatRule(rule)
  // 锚点之前一律不算：day / anchor 都是 YYYY-MM-DD，字典序即日期序。
  // 必须在四个 unit 分支之前统一短路——W/M/Y 的周/月/年差粒度比天粗，
  // 同周期内早于锚点的日期差值为 0，会让它们误判成命中。
  if (day < anchor) return false

  const diff = (utc(day) - utc(anchor)) / DAY_MS
  const [dy, dm, dd] = day.split('-').map(Number)

  if (r.unit === 'D') return diff % r.n === 0

  if (r.unit === 'W') {
    if (!r.weekdays.includes(isoWeekday(day))) return false
    const monday = (s: string): number => utc(s) - (isoWeekday(s) - 1) * DAY_MS
    const weeks = (monday(day) - monday(anchor)) / (7 * DAY_MS)
    return weeks % r.n === 0
  }

  if (r.unit === 'M') {
    const [ay, am] = anchor.split('-').map(Number)
    const months = dy * 12 + dm - (ay * 12 + am)
    if (months % r.n !== 0) return false
    const last = lastDayOfMonth(dy, dm)
    if (r.monthDays.length > 0) {
      if (r.monthDays.includes(dd)) return true
      return dd === last && r.monthDays.some(x => x > last)
    }
    const anchorDay = Number(anchor.slice(8, 10))
    if (dd === anchorDay) return true
    return dd === last && anchorDay > last
  }

  const years = dy - Number(anchor.slice(0, 4))
  if (years % r.n !== 0) return false
  const md = r.monthDay ?? anchor.slice(5)
  const target = md === '02-29' && !isLeapYear(dy) ? '02-28' : md
  return day.slice(5) === target
}

export function describeRepeatRule(rule: string | null): string {
  const r = parseRepeatRule(rule)
  if (r.unit === 'D') return r.n === 1 ? '每天' : `每 ${r.n} 天`
  if (r.unit === 'W') {
    const chars = r.weekdays.map(w => WEEKDAY_CHAR[w - 1]).join('、')
    return r.n === 1 ? `每周${chars}` : `每 ${r.n} 周的周${chars}`
  }
  if (r.unit === 'M') {
    if (r.monthDays.length === 0) {
      return r.n === 1 ? '每月同日' : `每 ${r.n} 月的同日`
    }
    const days = r.monthDays.join('、')
    return r.n === 1 ? `每月 ${days} 日` : `每 ${r.n} 月的 ${days} 日`
  }
  if (r.monthDay === null) {
    return r.n === 1 ? '每年同日' : `每 ${r.n} 年的同日`
  }
  const month = Number(r.monthDay.slice(0, 2))
  const date = Number(r.monthDay.slice(3))
  return r.n === 1
    ? `每年 ${month} 月 ${date} 日`
    : `每 ${r.n} 年的 ${month} 月 ${date} 日`
}
