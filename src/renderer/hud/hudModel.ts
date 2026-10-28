import type { Occurrence, Task } from '@shared/types/domain'
import { fmtPoints } from '@shared/format'

/**
 * HUD 的纯模型（W9 · 04 §5）。
 *
 * 纪律：
 * - **不算分**：分值只来自 `bootstrap.today.points` 与 `points.changed` 的载荷，
 *   这里只做字符串格式化（`fmtPoints`）与计数（完成数 / 待办数），不出现任何积分运算；
 * - 界面串只用 04 已登记的：`● 3/5`、`今日 +42`、任务标题——本文件不产出别的文案。
 */

/** 一行 = 一个每日任务今日打卡，或一个限时/活动任务 */
export interface HudRow {
  kind: 'occurrence' | 'task'
  id: string
  title: string
  done: boolean
}

/** 展开列表最多 6 条（04 §5.2） */
export const ROW_LIMIT = 6

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/**
 * 本地日历日 `YYYY-MM-DD`。渲染层自用，不引主进程模块。
 * 与 `features/tasks/tasksModel.ts`、`features/calendar/calendarModel.ts` 同口径
 * （都用 getFullYear/getMonth/getDate，不用 toISOString）；三处重复的清理已登记在
 * DELTA v0.18 第 4 条，等 W9 收工后统一提到 `src/shared`，本轮不动。
 */
export function localDayOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 完成率（积分环）：今日已打卡 / 今日应打卡；没有每日任务时为 0，不除零 */
export function completionRatio(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, done / total))
}

/** `3/5`（04 §5.2 的 `● 3/5`，圆点在组件里画，不在这里拼） */
export function ratioLabel(done: number, total: number): string {
  return `${done}/${total}`
}

/** `今日 +42`：正数带 `+`，负数沿用 fmtPoints 的负号，小数最多 2 位（与 04 §4③ 同口径） */
export function todayPointsLabel(points: number): string {
  return `今日 ${points > 0 ? '+' : ''}${fmtPoints(points)}`
}

/**
 * 列表行：先每日打卡（今天的固定动作），再限时/活动（服务端已按 sortKey 排序）。
 * 已完成的每日打卡仍留在列表里（`●` 态），否则"3/5"与列表对不上。
 */
export function buildRows(
  occurrences: Occurrence[],
  tasks: Task[],
  limit = ROW_LIMIT
): HudRow[] {
  const rows: HudRow[] = [
    ...occurrences.map(o => ({
      kind: 'occurrence' as const,
      id: o.id,
      title: o.taskTitle ?? '',
      done: o.status === 'done'
    })),
    ...tasks.map(t => ({
      kind: 'task' as const,
      id: t.id,
      title: t.title,
      done: t.status === 'done'
    }))
  ]
  return limit > 0 ? rows.slice(0, limit) : rows
}

/** 收起态 dock-bar 右侧的"最近待办标题"：列表里第一条未完成的；全完成则取第一条 */
export function recentTitle(rows: HudRow[]): string | null {
  const pending = rows.find(r => !r.done)
  return (pending ?? rows[0])?.title ?? null
}

/** float-pod 角标：还没做的数量（未打卡的每日任务 + 未完成的任务） */
export function pendingCount(occurrences: Occurrence[], tasks: Task[]): number {
  const pendingOccurrences = occurrences.filter(o => o.status === 'pending').length
  const pendingTasks = tasks.filter(t => t.status !== 'done').length
  return pendingOccurrences + pendingTasks
}
