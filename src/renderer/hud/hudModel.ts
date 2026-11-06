import type { Occurrence, Task } from '@shared/types/domain'
import { dueInstant, dueLocalDay } from '@shared/due'
import { fmtPoints } from '@shared/format'
import { toLocalDay } from '@shared/localDay'

/**
 * HUD 的纯模型（W9 · 04 §5 v0.30）。
 *
 * 纪律：
 * - **不算分**：分值只来自 `bootstrap.today.points` 与 `points.changed` 的载荷，
 *   这里只做字符串格式化（`fmtPoints`）与计数（完成数 / 待办数），不出现任何积分运算；
 * - 界面串只用 04 已登记的：`● 3/5`、`今日 +42`、任务标题、v0.62 长条上的 `62°`——本文件不产出别的文案。
 */

/** 行类型档（排序第二级：每日 → 限时 → 活动，04 §5.3 v0.38） */
export type HudRowType = 'daily' | 'deadline' | 'event'

/** 一行 = 一个每日任务今日打卡，或一个限时/活动任务 */
export interface HudRow {
  kind: 'occurrence' | 'task'
  id: string
  title: string
  /**
   * 已结束（完成 `done` 或判失败 `missed`）——决定沉底与变淡（04 §5.3）。
   * 每日行能不能勾由 `kind === 'occurrence'` 决定，与本字段无关。
   */
  done: boolean
  type: HudRowType
  /** 只有每日打卡能在 HUD 里勾；限时/活动一律要过审，这里只起提醒作用（v0.38） */
  completable: boolean
  /** 行尾截止日 `MM-DD`（从 `dueAt` 派生）；每日打卡行恒为 `''`，空串不进 DOM */
  dueLabel: string
}

/** 类型档的排序权重（写死，不参与任何积分/业务判断） */
const TYPE_RANK: Record<HudRowType, number> = { daily: 0, deadline: 1, event: 2 }

/**
 * 本地日历日 `YYYY-MM-DD`。
 * v0.20 起实现只有一份，在 `src/shared/localDay.ts`；这里 re-export 旧名，调用方不动。
 */
export { toLocalDay as localDayOf } from '@shared/localDay'

/** 完成率（长条上的进度环）：已结束行 / 列表总行数（v0.39 与列表同源）；空列表为 0，不除零 */
export function completionRatio(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, done / total))
}

/** `3/5`（04 §5.3 的 `● 3/5`，圆点在组件里画，不在这里拼） */
export function ratioLabel(done: number, total: number): string {
  return `${done}/${total}`
}

/**
 * 长条手势判定阈值（04 §5.2.2）：按下即进入**预备拖动**（窗口不动），
 * 位移一旦超过 `TAP_TOLERANCE` 就开始跟手；松开时仍未超过 → 视为点按，展开面板。
 * 不再有时间阈值——「按住多久才算拖动」会让手一停就感觉卡住。
 */
export const TAP_TOLERANCE = 4

/**
 * 星期几（v0.31 长条最右一格）：`周日`…`周六`。
 * 硬编码而不用 `toLocaleDateString('zh-CN', { weekday })`——那个依赖 ICU 数据，
 * 打包/精简运行时的输出可能与开发时不一致。
 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export function weekdayLabel(date: Date): string {
  return WEEKDAYS[date.getDay()]
}

/**
 * 长条上的单路温度：`62°`；拿不到就是 `--`（v0.62）。
 * 不带单位 C——长条只有 132px，`°` 已经能表达温度。
 */
export function tempLabel(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}°`
}

/** `今日 +42`：正数带 `+`，负数沿用 fmtPoints 的负号，小数最多 2 位（与 04 §4③ 同口径） */
export function todayPointsLabel(points: number): string {
  return `今日 ${points > 0 ? '+' : ''}${fmtPoints(points)}`
}

/** `dueAt` → 时间戳（v0.53 走 dueInstant）；null / 空串 / 解析不出数字一律 null（同档内排在最后） */
function dueTimestamp(dueAt: string | null): number | null {
  if (dueAt === null || dueAt.length === 0) return null
  const at = dueInstant(dueAt)
  return at === null ? null : at.getTime()
}

/** `dueAt` → 行尾的 `MM-DD`；`day` 归当天、`month` 归月末都交给 `dueLocalDay`；判不出给 `''` */
export function hudDueLabel(dueAt: string | null): string {
  const day = dueLocalDay(dueAt)
  return day === null ? '' : day.slice(5)
}

/**
 * HUD 只留截止日落在「今天 ~ 今天+7 天」（含两端）的任务。
 *
 * 两类任务不受窗口约束：已结束（`done` / `missed`，今天刚结束的必须还看得见）、
 * `dueLocalDay` 判不出日期的（不凭空丢）。其余用 `YYYY-MM-DD` 字符串字典序比较，
 * 不转 Date 比毫秒；窗口末端用本地日历加 7 天，不用 UTC 切日期。
 */
export function withinHudWindow(tasks: Task[], today: string): Task[] {
  const [year, month, day] = today.split('-').map(Number)
  const end = toLocalDay(new Date(year, month - 1, day + 7))
  return tasks.filter(task => {
    if (task.status === 'done' || task.status === 'missed') return true
    const dueDay = dueLocalDay(task.dueAt)
    if (dueDay === null) return true
    return dueDay >= today && dueDay <= end
  })
}

/**
 * 列表行（04 §5.3 v0.38）：不再截断，列表本身滚动。
 *
 * 排序三级，写死：
 * 1. 已完成的沉底（`done ? 1 : 0` 升序）；
 * 2. 类型档升序：`daily` → `deadline` → `event`；
 * 3. 同档内 `deadline` / `event` 按 `dueAt` 升序，缺失或非法值排同档最后；
 *    `daily` 没有截止时间，不参与这级比较（靠 `sort` 的稳定性保持传入顺序）。
 *
 * **每日任务必须从 `tasks` 里滤掉**：`bootstrap.tasks` 是"活跃任务"，其中包含每日任务的
 * 任务行（status=todo），而那一天的动作在 occurrence 上。不滤掉会出现两行同标题——
 * 打卡行正常，任务行走 `task.complete` 被服务端拒绝（"每日任务不进入审核/完成状态"）。
 */
export function buildRows(occurrences: Occurrence[], tasks: Task[]): HudRow[] {
  const entries: { row: HudRow; due: number | null }[] = [
    ...occurrences.map(o => ({
      row: {
        kind: 'occurrence' as const,
        id: o.id,
        title: o.taskTitle ?? '',
        done: o.status === 'done',
        // occurrence 只由每日任务产生，类型恒为 daily
        type: 'daily' as const,
        completable: true,
        dueLabel: ''
      },
      due: null
    })),
    ...tasks
      .filter(t => t.type !== 'daily')
      .map(t => ({
        row: {
          kind: 'task' as const,
          id: t.id,
          title: t.title,
          // `missed` 是失败终点态，与完成同属"已结束"（04 §5.3 v0.39）
          done: t.status === 'done' || t.status === 'missed',
          type: t.type,
          completable: false,
          dueLabel: hudDueLabel(t.dueAt)
        },
        due: dueTimestamp(t.dueAt)
      }))
  ]

  // ES2019 起 Array.prototype.sort 是稳定排序，相等项保持传入顺序
  entries.sort((a, b) => {
    const doneDiff = Number(a.row.done) - Number(b.row.done)
    if (doneDiff !== 0) return doneDiff

    const rankDiff = TYPE_RANK[a.row.type] - TYPE_RANK[b.row.type]
    if (rankDiff !== 0) return rankDiff

    if (a.row.type === 'daily') return 0

    if (a.due === null || b.due === null) {
      if (a.due === b.due) return 0
      return a.due === null ? 1 : -1
    }
    return a.due - b.due
  })

  return entries.map(entry => entry.row)
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
