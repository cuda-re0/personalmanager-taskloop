import type { DayStat, PointEntry } from '@shared/types/domain'
import { fmtPoints } from '@shared/format'
import { formatSigned, monthStartOf } from './pointsModel'

/**
 * 明细页（04 §4④ v0.24）的纯模型。
 *
 * 分工与 `pointsModel` 一致：**日期算术、分组、净额、月份格式化全在这里**，组件只负责摆放。
 * 组件里出现 `new Date` / `getMonth` / `setDate` 就算越界（本单硬性口径 3）。
 *
 * 纪律：不算分。净额是 `DayStat.points` 的求和，`±N` 是流水自带的 `delta`——
 * 两者都不在这里重新推导（流水被 `limit` 截断时，净额仍必须正确，见 `monthNetOf`）。
 */

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** 某年某月的天数：按日历算（`Date.UTC(y, m, 0)` = 上个月最后一天），不写死 30 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 月末日 `YYYY-MM-DD`（`month` 是当月 1 号） */
export function monthEndOf(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  return `${month.slice(0, 7)}-${pad2(daysInMonth(year, mon))}`
}

/** 当月查询区间：`points.ledger({ from, to })` 用闭区间，`to` 必须是真实月末 */
export function monthRangeOf(month: string): { from: string; to: string } {
  return { from: month, to: monthEndOf(month) }
}

/** 按月翻页：`delta` 为 ±1。跨年由「年月折算成月序号」处理，不碰 Date */
export function shiftMonthOf(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number)
  const index = year * 12 + (mon - 1) + delta
  const y = Math.floor(index / 12)
  const m = index - y * 12 + 1
  return `${y}-${pad2(m)}-01`
}

/** 页头 `2026年10月`（`month` 是当月 1 号） */
export function monthLabelOf(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  return `${year}年${mon}月`
}

/** 分组头 `10月28日`：不写「今天」「昨天」（跨天边界没有相对时间语义） */
export function dayLabelOf(day: string): string {
  const [, mon, d] = day.split('-').map(Number)
  return `${mon}月${d}日`
}

/** 当前月不能往后翻：`›` 的 disabled 判据，也是 `stepMonthOf` 的兜底 */
export function canGoNextMonth(month: string, today: string): boolean {
  return month < monthStartOf(today)
}

/**
 * 翻月一步：目标落在未来月时**原样返回当前月**（04 §4④「当月不可往后翻」）。
 * 按钮的 `disabled` 是第一道闸，这里是不依赖 UI 的第二道——只靠 disabled 的话，
 * 将来任何别处调用 `shiftMonth(+1)` 都能翻进未来月。
 */
export function stepMonthOf(month: string, delta: number, today: string): string {
  const next = shiftMonthOf(month, delta)
  return canGoNextMonth(next, today) ? next : month
}

/**
 * 当月净额 = 当月 `DayStat.points` 求和。
 *
 * **不能用流水求和**：流水查询带 `limit: 500`，一个月超过 500 条时尾部会被截断，
 * 求和就少了；日聚合是主进程按天物化的，天然完整（04 §4④ v0.24）。
 */
export function monthNetOf(stats: DayStat[]): number {
  let total = 0
  for (const stat of stats) total += stat.points
  return total
}

export interface LedgerDayGroup {
  day: string
  /** 该日净额：组内 `delta` 求和 */
  net: number
  /** 组内流水，`createdAt` 降序 */
  entries: PointEntry[]
}

function compareIsoDesc(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta
  return a < b ? 1 : a > b ? -1 : 0
}

/**
 * 按 `day` 分组：组间 `day` 降序、组内 `createdAt` 降序（同日同刻用 id 兜底，保证稳定）。
 * 入参顺序不参与决策——服务端已按 `created_at DESC` 返回，但这里不依赖那个顺序。
 */
export function groupEntriesByDay(entries: PointEntry[]): LedgerDayGroup[] {
  const map = new Map<string, PointEntry[]>()
  for (const entry of entries) {
    const list = map.get(entry.day)
    if (list) list.push(entry)
    else map.set(entry.day, [entry])
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, list]) => {
      const sorted = [...list].sort(
        (x, y) => compareIsoDesc(x.createdAt, y.createdAt) || compareIsoDesc(x.id, y.id)
      )
      let net = 0
      for (const entry of sorted) net += entry.delta
      return { day, net, entries: sorted }
    })
}

/**
 * 净额/日净额的展示：`+12` / `-1` / `0`。
 *
 * 与流水行的 `±N` 同一套样式来源（`ledger-delta`），但零值显示 `0` 而不是 `+0`：
 * 加号在聚合值上没有信息量，04 §4④ 的页头示例写的就是 `0`。
 */
export function netLabel(value: number): string {
  return fmtPoints(value) === '0' ? '0' : formatSigned(value)
}
