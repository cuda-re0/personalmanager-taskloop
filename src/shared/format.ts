import { dueHasTime, dueInstant, duePrecisionOf } from './due'
import { toLocalDay } from './localDay'
import { roundPoints } from './points/rubric'
import type { TaskType } from './types/domain'

/**
 * 分值显示（04 §4③）：最多 2 位小数、去掉尾零。
 *
 * 23 → '23'；10.75 → '10.75'；5.5 → '5.5'；-10.75 → '-10.75'。
 * 精度收敛只发生在 roundPoints 里，本文件不做别的取整与定点格式化。
 */
export function fmtPoints(v: number): string {
  return String(roundPoints(v))
}

/**
 * 金额显示（45 §7.1）：分 → 元，整数不带小数点、有小数保留两位，**去尾零**。
 *
 * 1200 → '12'；1250 → '12.5'；1205 → '12.05'。
 *
 * 全程整数运算（先整除百位、余数当"分"再拼字符串）：金额一旦经过浮点，
 * `12.5 * 100 = 1250.0000000000002` 这类误差会顺着"已花 / 500"一路漂到界面上。
 * 本文件与 `fmtPoints` 共享同一条纪律：不做任何取整或定点格式化调用。
 * 负数由调用方负责加符号（这里只画金额本身）。
 */
export function fmtMoney(cents: number): string {
  const total = cents < 0 ? -Math.trunc(cents) : Math.trunc(cents)
  const yuan = (total - (total % 100)) / 100
  const fen = total % 100
  if (fen === 0) return String(yuan)
  if (fen % 10 === 0) return `${yuan}.${fen / 10}`
  return `${yuan}.${String(fen).padStart(2, '0')}`
}

/**
 * 剩余时间（04 §4①：限时 `2h` / `明天` / `逾期`，活动 `7d`）。
 *
 * v0.58 起从渲染层的 `tasksModel` 上移到共享层：主进程算提醒窗口的负载也要用它，
 * 两个进程各写一份会在读秒边界上分叉（一个说 `1h`、一个说 `59m`）。**全项目唯一一份。**
 *
 * 字段值格式化，不是界面文案；天数整除显示，不产出积分值。
 * `dueAt` 的「截止瞬间」一律走 `@shared/due` 的 `dueInstant`，不裸解析。
 */
export function fmtRemaining(dueAt: string | null, type: TaskType, now: Date): string {
  if (type !== 'deadline' && type !== 'event') return ''
  if (!dueAt) return ''
  const due = dueInstant(dueAt)
  if (due === null) return ''
  const diffHours = (due.getTime() - now.getTime()) / 3600000
  if (diffHours < 0) return '逾期'

  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = type === 'deadline' && toLocalDay(due) === toLocalDay(tomorrow)

  if (dueHasTime(dueAt)) {
    if (diffHours < 24) return `${Math.max(1, Math.floor(diffHours))}h`
    if (isTomorrow) return '明天'
    return `${Math.floor(diffHours / 24)}d`
  }

  // 没有具体时刻（day / month）：只按整天口径，不出现小时数——出现小时数等于替他编了个时刻
  if (isTomorrow) return '明天'
  return `${Math.max(1, Math.ceil(diffHours / 24))}d`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 目标时间的显示值（v0.59）：`11-03 14:00` / `11-03` / `2026-11`（三档精度各自的样子）。
 *
 * 从 `reminderService.dueLabelOf` 原样上移：提醒窗口的负载与右栏的「剩余 · 目标」用的是同一份，
 * 两处各写会在精度分档上悄悄分叉。**全项目唯一一份。**
 *
 * 一律走 `dueInstant` 拿归一后的时刻（day / month 归当天 / 月末的 23:59:59），不裸解析。
 */
export function fmtDueLabel(dueAt: string | null): string {
  const precision = duePrecisionOf(dueAt)
  if (precision === null) return ''
  const at = dueInstant(dueAt)
  if (at === null) return ''

  if (precision === 'month') return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}`
  const head = `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
  return precision === 'minute' ? `${head} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : head
}

/**
 * `<input type="datetime-local">` 的 value（v0.59）：本地 `YYYY-MM-DDTHH:mm`，不带秒、不带时区。
 *
 * 日 / 月级 due 会归一成当天 / 月末的 `23:59`——那是 `dueInstant` 的既有口径，
 * 不在这里为输入框另造一个「09:00 之类」的假时刻。
 */
export function toDatetimeLocal(dueAt: string | null): string {
  const at = dueInstant(dueAt)
  if (at === null) return ''
  const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
  return `${day}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}
