import type { Occurrence, Task } from '@shared/types/domain'
import { fmtPoints } from '@shared/format'

/**
 * HUD 的纯模型（W9 · 04 §5 v0.30）。
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

/** 展开列表最多 6 条（04 §5.3） */
export const ROW_LIMIT = 6

/**
 * 本地日历日 `YYYY-MM-DD`。
 * v0.20 起实现只有一份，在 `src/shared/localDay.ts`；这里 re-export 旧名，调用方不动。
 */
export { toLocalDay as localDayOf } from '@shared/localDay'

/** 完成率（球上的进度环）：今日已打卡 / 今日应打卡；没有每日任务时为 0，不除零 */
export function completionRatio(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, done / total))
}

/** `3/5`（04 §5.3 的 `● 3/5`，圆点在组件里画，不在这里拼） */
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
 *
 * **每日任务必须从 `tasks` 里滤掉**：`bootstrap.tasks` 是"活跃任务"，其中包含每日任务的
 * 任务行（status=todo），而那一天的动作在 occurrence 上。不滤掉会出现两行同标题——
 * 打卡行正常，任务行走 `task.complete` 被服务端拒绝（"每日任务不进入审核/完成状态"）。
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
    ...tasks
      .filter(t => t.type !== 'daily')
      .map(t => ({
        kind: 'task' as const,
        id: t.id,
        title: t.title,
        done: t.status === 'done'
      }))
  ]
  return limit > 0 ? rows.slice(0, limit) : rows
}

/** 没做的数量（未打卡的每日任务 + 未完成的任务） */
export function pendingCount(occurrences: Occurrence[], tasks: Task[]): number {
  const pendingOccurrences = occurrences.filter(o => o.status === 'pending').length
  const pendingTasks = tasks.filter(t => t.status !== 'done').length
  return pendingOccurrences + pendingTasks
}

/**
 * 背景合成的输入：`hud.background`（null → 主题 `--bg`）与 `hud.opacity`。
 *
 * 透明度**只进 rgba 的 alpha**（04 §5.4）：把 `opacity` 加在容器上会把文字一起变淡，
 * 那是明令禁止的做法。颜色既接受 `#rgb` / `#rrggbb`，认不出时退回白色，不抛错。
 */
export function composeHudBg(
  background: string | null,
  opacity: number,
  themeBg: string
): string {
  const rgb = parseHexColor(background ?? '') ?? parseHexColor(themeBg) ?? { r: 255, g: 255, b: 255 }
  const alpha = Math.min(1, Math.max(0, opacity))
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

interface Rgb {
  r: number
  g: number
  b: number
}

/** `#fff` / `#ffffff` → RGB；其它格式（rgb()/命名色）返回 null，由调用方兜底 */
export function parseHexColor(value: string): Rgb | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim())
  if (!match) return null
  const hex = match[1]
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map(c => c + c)
          .join('')
      : hex
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16)
  }
}
