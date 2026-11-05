import type { Occurrence, Task, TaskType } from '@shared/types/domain'
import { dueInstant, duePrecisionOf } from '@shared/due'
import { fmtDueLabel, fmtRemaining, toDatetimeLocal } from '@shared/format'
import { toLocalDay as localDayOf } from '@shared/localDay'

/**
 * 右栏①「当前任务」的纯模型（04 §4①）。导出只为可测，组件不另写排序/分组逻辑。
 */

/** 04 §4① 组内排序：doing 优先 → priority 降序 → 时间升序（null 最后）→ sortKey */
export function compareTasks(a: Task, b: Task): number {
  const rank = (t: Task): number => (t.status === 'doing' ? 0 : 1)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (a.priority !== b.priority) return b.priority - a.priority
  // 比「截止瞬间」而不是原串：月级 due_at 是 `2026-11`，按字符串比会排到该月最前（v0.53）
  const at = dueInstant(a.dueAt)
  const bt = dueInstant(b.dueAt)
  if (at === null || bt === null) {
    // 没有截止时间、或解析不出的排最后
    if (at === null && bt === null) return a.sortKey - b.sortKey
    return at === null ? 1 : -1
  }
  if (at.getTime() !== bt.getTime()) return at.getTime() - bt.getTime()
  return a.sortKey - b.sortKey
}

/**
 * 今日已完成（v0.27 用户裁决「已完成的变淡显示」）：done 且 completedAt 的本地日是今天。
 * 明天这条自然为 false——限时/活动组的行靠它过滤，跨天自动消失，不做任何清理逻辑。
 */
export function isDoneToday(task: Task, today: string): boolean {
  return (
    task.status === 'done' &&
    task.completedAt !== null &&
    localDayOf(new Date(task.completedAt)) === today
  )
}

/**
 * 今日被判失败（v0.34）：`missed` 没有 `completedAt`（不是用户完成的，是审核驳回时判的），
 * 所以看 `updatedAt` 的本地日是不是今天。与 done 同一条「靠过滤跨天消失」的口径。
 */
export function isMissedToday(task: Task, today: string): boolean {
  return task.status === 'missed' && localDayOf(new Date(task.updatedAt)) === today
}

/** 每日组的一行：今日 occurrence + 联带的任务（streak 显示用） */
export interface DailyRow {
  occurrence: Occurrence
  task: Task | null
}

export interface TaskGroups {
  daily: DailyRow[]
  deadline: Task[]
  event: Task[]
}

/**
 * 三组分列（04 §4①）。每日组 = **today 这一天**的 pending + done occurrence（v0.27：
 * 打完卡当天行还在，变淡沉底）；限时/活动组 = 顶层任务（子步骤跟父任务展开，不单列），
 * 活跃行在前（原排序），今日已完成的沉底（内部保持原排序），非今天的 done 不出现。
 *
 * `today` 显式传参（默认取本地今天）而不是在函数里读时钟：这是纯模型，要可测。
 * 过滤掉非今天的行是硬要求（v0.21）——`ensureRange` 会预生成今天~+3 天的 occurrence，
 * 一旦漏进来，每日组就变成同一任务 4 行，用户点掉即给未来日期提前打卡。
 */
export function groupTasks(
  tasks: Task[],
  occurrences: Occurrence[],
  today: string = localDayOf(new Date())
): TaskGroups {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const daily = occurrences
    .filter(o => o.day === today && (o.status === 'pending' || o.status === 'done'))
    .map(o => ({ occurrence: o, task: byId.get(o.taskId) ?? null }))
    .sort((a, b) => {
      // pending 在前、done 沉底（v0.27），各段内部按原 sortKey
      const rank = (r: DailyRow): number => (r.occurrence.status === 'pending' ? 0 : 1)
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      return (a.task?.sortKey ?? 0) - (b.task?.sortKey ?? 0)
    })
  const topLevel = tasks.filter(t => t.parentId === null)
  // 活跃在前（原排序不动），今日 done / missed 沉底（内部保持原排序）；
  // done / missed 但不是今天的直接不出现（v0.27 done、v0.34 missed）。
  // v0.38：pending_review（待提交）算活跃——用户还要交材料，不能沉底也不能消失。
  const byType = (type: TaskType): Task[] => [
    ...topLevel
      .filter(t => t.type === type && t.status !== 'done' && t.status !== 'missed')
      .sort(compareTasks),
    ...topLevel
      .filter(t => t.type === type && (isDoneToday(t, today) || isMissedToday(t, today)))
      .sort(compareTasks)
  ]
  return {
    daily,
    deadline: byType('deadline'),
    event: byType('event')
  }
}

/**
 * 行右侧的剩余时间（04 §4①：限时 `2h` / `明天` / `逾期`，活动 `7d`）。
 *
 * 实现已上移到 `@shared/format` 的 `fmtRemaining`（v0.58）：主进程算提醒窗口负载时
 * 用的是同一份，别在这里另写一套。本函数保留原签名，调用点与测试不必改。
 */
export function remainingLabel(task: Task, now: Date): string {
  return fmtRemaining(task.dueAt, task.type, now)
}

/**
 * 日期编辑的可用性（v0.66）；v0.75 起它只回答「这个日期能不能编辑」，
 * 不再决定控件类型——两处编辑都是「日期 + 时间」两个框，时间可留空。
 */
export type DueEditKind = 'minute' | 'day'

/** null = 不给编辑（无日期 / 月精度 / 解析不出来） */
export function dueEditKindOf(dueAt: string | null): DueEditKind | null {
  const precision = duePrecisionOf(dueAt)
  if (precision === 'minute') return 'minute'
  if (precision === 'day') return 'day'
  return null
}

/** 日期框 value：`YYYY-MM-DD`。minute 取本地日期，day 取原串前 10 位；month / null → '' */
export function dueDateValueOf(dueAt: string | null): string {
  const precision = duePrecisionOf(dueAt)
  if (precision === 'minute') return toDatetimeLocal(dueAt).slice(0, 10)
  // day 的串本身就是本地日历日，绕一道 Date 会在西半球串到前一天
  if (precision === 'day') return (dueAt as string).slice(0, 10)
  return ''
}

/** 时间框 value：`HH:mm`。day / month / null → ''（没有时刻就是空，不许补 23:59） */
export function dueTimeValueOf(dueAt: string | null): string {
  if (duePrecisionOf(dueAt) !== 'minute') return ''
  return toDatetimeLocal(dueAt).slice(11, 16)
}

/**
 * 日期 + 时间 → 写库的 dueAt：time 为空 → date 原样返回（day 精度）；否则本地解析后 toISOString()（minute 精度）。
 *
 * `day` 的串本身就是本地日历日，转一道 Date 再 toISOString 会串成前一天
 * （`2026-11-05` 变 `2026-11-04T16:00:00.000Z`），所以时间留空时必须原样写回；
 * 出现时间框就补一个 23:59 是错的——用户没填就是没填。
 */
export function duePatchOfParts(date: string, time: string): string {
  if (date === '') return ''
  if (time === '') return date
  // `YYYY-MM-DDTHH:mm` 不带时区 → 按本地时区解析，与 toDatetimeLocal 同一口径
  return new Date(`${date}T${time}`).toISOString()
}

/** 活动的日期能否就地改（v0.65；v0.66 起限时也算）：类型 + 状态 + 有可编辑精度的日期，三条同时满足 */
export function canEditDueOf(task: Task): boolean {
  if (task.type !== 'event' && task.type !== 'deadline') return false
  if (task.status !== 'todo' && task.status !== 'doing') return false
  return dueEditKindOf(task.dueAt) !== null
}

/** 行右列的两段（v0.65）：拆开是为了让「日期」那段单独可点，拼接规则仍归 taskRightLabel */
export function taskRightParts(task: Task, now: Date): { remaining: string; due: string } {
  if (task.status === 'done' || task.status === 'missed') return { remaining: '', due: '' }
  return { remaining: remainingLabel(task, now), due: fmtDueLabel(task.dueAt) }
}

/**
 * 行右侧的一行（v0.59）：剩余在前、目标在后，` · ` 分隔（`2d · 11-03 14:00`）。
 *
 * 已完成 / 已判失败的行留空（与 v0.27 / v0.34 的既有口径一致）；只有一个值时不画多余的分隔符。
 * v0.65 起两段由 `taskRightParts` 产出，本函数只负责拼——拼接规则仍然只有这一份。
 */
export function taskRightLabel(task: Task, now: Date): string {
  const { remaining, due } = taskRightParts(task, now)
  if (remaining === '' && due === '') return ''
  if (remaining === '') return due
  if (due === '') return remaining
  return `${remaining} · ${due}`
}

/** 步骤是否已勾（勾选 = 状态离开 todo；完成语义归 W6/W7，见 useTasksData 注释） */
export function isStepChecked(step: Task): boolean {
  return step.status !== 'todo'
}
