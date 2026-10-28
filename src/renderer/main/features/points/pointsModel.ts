import type { DayStat, PointEntry } from '@shared/types/domain'
import { fmtPoints } from '@shared/format'

/**
 * 右栏 ③「积分」/ ④「明细」的纯模型（04 §4③④）。导出只为可测：
 * 组件里不再写区间换算、格式化、柱子高度这类逻辑。
 *
 * 纪律（红线 8）：这里**不算分**。余额、今日/本周、柱子高度都来自服务端返回值
 * （`points.balance` / `points.monthStats` / `points.ledger`）与 `fmtPoints` 的展示格式；
 * 本文件只做日期换算、求和与字符串格式化。
 */

export type LedgerRange = 'today' | 'week' | 'month'

/** 04 §4④ 顶部的三个切换（已登记的固定标签） */
export const RANGE_LABEL: Record<LedgerRange, string> = {
  today: '今日',
  week: '本周',
  month: '本月'
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** 本地日历日 `YYYY-MM-DD`（渲染层自用，不引主进程模块） */
export function localDayOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 日期加减：按 UTC 午夜算再拆回字符串，避免夏令时把天数算歪 */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/** 本周一（01 §2.1.3 的 ISO 周几：1=周一 … 7=周日） */
export function weekStartOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const isoDow = dow === 0 ? 7 : dow
  return shiftDay(day, -(isoDow - 1))
}

/** 本月 1 号 */
export function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`
}

/** 某个切换对应的查询区间（都是「截至今天」的闭区间） */
export function rangeOf(range: LedgerRange, today: string): { from: string; to: string } {
  if (range === 'today') return { from: today, to: today }
  if (range === 'week') return { from: weekStartOf(today), to: today }
  return { from: monthStartOf(today), to: today }
}

/** 最近 N 天（含今天，升序）——7 日迷你柱状用 */
export function lastDays(today: string, count = 7): string[] {
  const out: string[] = []
  for (let i = count - 1; i >= 0; i -= 1) out.push(shiftDay(today, -i))
  return out
}

/** day → 当日积分（来自服务端 DayStat） */
export function pointsByDay(stats: DayStat[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const stat of stats) map.set(stat.day, stat.points)
  return map
}

/** 闭区间内的积分合计，只加服务端给的日聚合值 */
export function sumPoints(stats: DayStat[], from: string, to: string): number {
  let total = 0
  for (const stat of stats) if (stat.day >= from && stat.day <= to) total += stat.points
  return total
}

export interface PointsBar {
  day: string
  points: number
  /** 0~1 的比例，只用于 CSS 高度；全为 0 时给一条最矮的基线，避免柱子消失 */
  ratio: number
}

/**
 * 7 日柱状（04 §4③：无坐标轴、无图例）。高度按窗口内最大正值的比例给，
 * 负数（冲销日）按 0 处理——柱子朝下画不在这一版的规格里。
 */
export function barsOf(stats: DayStat[], today: string, count = 7): PointsBar[] {
  const byDay = pointsByDay(stats)
  const days = lastDays(today, count)
  const values = days.map(day => byDay.get(day) ?? 0)
  const peak = Math.max(1, ...values.map(v => (v > 0 ? v : 0)))
  return days.map((day, i) => {
    const points = values[i]
    const positive = points > 0 ? points : 0
    return { day, points, ratio: positive === 0 ? 0.06 : Math.max(0.06, positive / peak) }
  })
}

/** `+11` / `-5` / `+0`：正负号是格式的一部分，数值本身走 fmtPoints */
export function formatSigned(value: number): string {
  const text = fmtPoints(value)
  return value > 0 ? `+${text}` : text === '0' ? '+0' : text
}

/** 流水行的时刻 `HH:mm`（本地时区） */
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 04 §4④ 的 `[撤销]` 三条件，缺一不可：
 * - `reasonCode === 'task_done'`：只有完成发分有撤销入口（冲销行、奖励行、手工调整都没有）；
 * - `occurrenceId === null`：非空的是每日打卡，撤销在 ① 的勾选框（走 `occurrence.undo`）；
 * - `reversedAt === null`：已冲销的行再撤就是重复冲销。
 *
 * **不判 24h 窗口**（04 §4④）：窗口要读 `completed_at`，渲染层不重复算主进程的规则，
 * 超窗的行照常显示 `[撤销]`，点下去由 `task.undo` 报「超过 24 小时的完成记录不能撤销」。
 */
export function canUndoEntry(entry: PointEntry): boolean {
  return (
    entry.reasonCode === 'task_done' && entry.occurrenceId === null && entry.reversedAt === null
  )
}
