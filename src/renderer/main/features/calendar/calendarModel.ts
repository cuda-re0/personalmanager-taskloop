import type { DayIndexEntry, DayTaskItem } from '@shared/types/domain'

/**
 * 右栏②「日历」的纯模型（04 §4②）。导出只为可测，组件不另写网格/日期/红点逻辑。
 *
 * 红点口径**不在这里算**：`total` / `doneCount` 由主进程 `calendar.dayIndex` 给（01 §4.1），
 * 本文件只把 `(total, doneCount)` 映射成「无点 / 实心 / 空心」三种视觉状态。
 */

/** 周一起始的列头。星期是日期字段，这里是它的显示形态（一二三四五六日） */
export const WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** `Date#getUTCDay()` 的 0 = 周日 */
const CN_WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'] as const

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/**
 * Date → 本地日历日 `YYYY-MM-DD`。
 *
 * v0.20：实现搬到 `src/shared/localDay.ts`（主进程与三个渲染层模块共用一份），这里只 re-export。
 * **不许** `toISOString().slice(0,10)`——那是 UTC 日，东八区 00:00–08:00 会差一天（01 §4.1）。
 */
export { toLocalDay } from '@shared/localDay'

/** 年月日 → 本地日字符串。纯算术，不经过 Date 的时区换算 */
export function dayOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** `dayIndex` 的依赖 key（同一个月重渲染不该再发请求，红线 2） */
export function monthKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`
}

/** 月份标题：`2026 年 10 月`（04 §4② 已给的显示格式） */
export function monthTitle(year: number, month: number): string {
  return `${year} 年 ${month} 月`
}

/** 上/下月切换，跨年正确（12 月 +1 → 次年 1 月，1 月 -1 → 上年 12 月） */
export function shiftMonth(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const index = month - 1 + delta
  // 月份整除不产出积分值，属 02 §5.2 取整禁令的例外（同 main/db/localDay.addMonths）
  return {
    year: year + Math.floor(index / 12),
    month: (((index % 12) + 12) % 12) + 1
  }
}

export interface MonthGrid {
  /** 每周 7 格；格内是日期数字，非本月为 null（04 §4②：不填充上月/下月灰字） */
  weeks: (number | null)[][]
}

/**
 * 月网格：周一起始，非本月留空格。
 *
 * 行数按实际需要给 5 或 6 行（不硬凑 6 行空行），高度由容器 240px 固定、行均分，
 * 切换月份时块高不跳。
 */
export function buildMonthGrid(year: number, month: number): MonthGrid {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const lead = (firstDow + 6) % 7 // 周一起始：周一 0 … 周日 6
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()

  const cells: (number | null)[] = []
  for (let i = 0; i < lead; i += 1) cells.push(null)
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const weeks: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return { weeks }
}

/** 红点的三种视觉状态。口径只来自主进程：合计 > 0 才有红点，全完成变空心 */
export type DotState = 'none' | 'solid' | 'hollow'

export function dotStateOf(entry: DayIndexEntry | undefined): DotState {
  if (!entry || entry.total <= 0) return 'none'
  return entry.doneCount >= entry.total ? 'hollow' : 'solid'
}

/** `dayIndex` 数组 → `YYYY-MM-DD` 索引。每格 O(1) 查，不按月全表扫（验收：1000 条量级不卡） */
export function indexByDay(entries: DayIndexEntry[]): Map<string, DayIndexEntry> {
  const map = new Map<string, DayIndexEntry>()
  for (const e of entries) map.set(e.day, e)
  return map
}

/** `YYYY-MM-DD` → `周二`（本地日历日，用 UTC 算术避免夏令时） */
export function weekdayCnOfDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return CN_WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/** 浮层标题：`10 月 27 日 周二`（04 §4② 的浮层示意） */
export function floorTitle(day: string): string {
  const [, m, d] = day.split('-').map(Number)
  return `${m} 月 ${d} 日 周${weekdayCnOfDay(day)}`
}

/**
 * 浮层行排序：按时间升序。
 *
 * `calendar.dayDetail` 已按 `due_at` 升序返回（02 §3.2c），这里只是稳定兜底——
 * 不改任何字段，也不补数据。同一时刻的多条按 `dueAt` 再按 id 定序，避免来回抖动。
 */
export function sortDayDetail(items: DayTaskItem[]): DayTaskItem[] {
  return [...items].sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1
    return 0
  })
}
