import { toLocalDay } from '../../shared/localDay'

/**
 * 每次请求注入的「当前时间」串（03 §9.6，格式写死，别自创）。
 *
 * ```
 * 【当前时间】2026-10-29 星期四 10:52（Asia/Shanghai）
 * 解析"明天/下周三/三小时后"这类相对时间时，一律以此为准，并换算成带时区的 ISO8601。
 * ```
 *
 * 为什么必须有这一段：实测 `due_hint` 恒为 null，根因就是 prompt 里没有当前时间——
 * 模型不知道"明天"是哪天，于是把"明天下午三点"写进 title。这一条不修，整个建任务功能
 * 等于废掉（03 §9.5 第一行）。
 *
 * 日期一律走 `src/shared/localDay.ts` 的本地日实现：**不许** `toISOString().slice(0, 10)`
 * ——那是 UTC 日，东八区 00:00–08:00 会差一天，而 dueAt 同时喂提醒、逾期判定与效率系数。
 */

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>()
const clockFormatters = new Map<string, Intl.DateTimeFormat>()

function weekdayFormatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let f = weekdayFormatters.get(key)
  if (!f) {
    // 取 short 英文名再映射：比 `{ weekday: 'long', locale: 'zh-CN' }` 稳，
    // 不依赖运行环境的 ICU 是否装了中文数据
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    weekdayFormatters.set(key, f)
  }
  return f
}

function clockFormatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let f = clockFormatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    clockFormatters.set(key, f)
  }
  return f
}

const WEEKDAY_BY_SHORT: Record<string, string> = {
  Sun: '星期日',
  Mon: '星期一',
  Tue: '星期二',
  Wed: '星期三',
  Thu: '星期四',
  Fri: '星期五',
  Sat: '星期六'
}

function weekdayOf(now: Date, timeZone?: string): string {
  const short = weekdayFormatter(timeZone).format(now)
  return WEEKDAY_BY_SHORT[short] ?? short
}

function clockOf(now: Date, timeZone?: string): string {
  const parts = clockFormatter(timeZone).formatToParts(now)
  const hour = parts.find(p => p.type === 'hour')?.value ?? '00'
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

/** 时区标签：显式传入优先，其次系统时区。东八区机器上就是 `Asia/Shanghai`（与 03 §9.6 一致） */
function zoneLabel(timeZone?: string): string {
  if (timeZone) return timeZone
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

/**
 * 纯函数版本（测试与需要钉死时钟的调用方用）。
 *
 * @param now 计算基准时刻，默认当前
 * @param timeZone 只给测试钉时区用，生产不传（= 系统本地时区）
 */
export function buildNowHint(now: Date = new Date(), timeZone?: string): string {
  const day = toLocalDay(now, timeZone)
  const weekday = weekdayOf(now, timeZone)
  const clock = clockOf(now, timeZone)
  return (
    `【当前时间】${day} ${weekday} ${clock}（${zoneLabel(timeZone)}）\n` +
    '解析"明天/下周三/三小时后"这类相对时间时，一律以此为准，并换算成带时区的 ISO8601。'
  )
}

/**
 * 生产入口：按**分钟**缓存，避免每条消息重算（03 §9.6 要求"别每条消息重算"）。
 *
 * 取分钟而不是整小时：缓存整小时会让"三小时后"这类相对时间最多差 59 分钟，
 * 而一次 `formatToParts` 只有微秒级——缓存的是重复计算，不是精度。
 */
let cachedKey = ''
let cachedHint = ''

export function nowHint(now: Date = new Date(), timeZone?: string): string {
  const key = `${toLocalDay(now, timeZone)}T${clockOf(now, timeZone)}|${zoneLabel(timeZone)}`
  if (key !== cachedKey) {
    cachedHint = buildNowHint(now, timeZone)
    cachedKey = key
  }
  return cachedHint
}
