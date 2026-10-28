import type { Occurrence, Task } from '@shared/types/domain'

/**
 * 右栏①「当前任务」的纯模型（04 §4①）。导出只为可测，组件不另写排序/分组逻辑。
 */

/** 04 §4① 组内排序：doing 优先 → priority 降序 → 时间升序（null 最后）→ sortKey */
export function compareTasks(a: Task, b: Task): number {
  const rank = (t: Task): number => (t.status === 'doing' ? 0 : 1)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.dueAt === null || b.dueAt === null) {
    // null 最后：一方 null 一方有值时，null 方排后面
    if (a.dueAt === null && b.dueAt === null) return a.sortKey - b.sortKey
    return a.dueAt === null ? 1 : -1
  }
  if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1
  return a.sortKey - b.sortKey
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
 * 三组分列（04 §4①）。每日组 = 今日仍 pending 的 occurrence；
 * 限时/活动组 = 顶层任务（子步骤跟父任务展开，不单列）。
 */
export function groupTasks(tasks: Task[], occurrences: Occurrence[]): TaskGroups {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const daily = occurrences
    .filter(o => o.status === 'pending')
    .map(o => ({ occurrence: o, task: byId.get(o.taskId) ?? null }))
    .sort((a, b) => (a.task?.sortKey ?? 0) - (b.task?.sortKey ?? 0))
  const topLevel = tasks.filter(t => t.parentId === null)
  return {
    daily,
    deadline: topLevel.filter(t => t.type === 'deadline').sort(compareTasks),
    event: topLevel.filter(t => t.type === 'event').sort(compareTasks)
  }
}

/** 本地日历日 YYYY-MM-DD（渲染层自用，不引主进程模块） */
function localDayOf(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 行右侧的剩余时间（04 §4①：限时 `2h` / `明天` / `逾期`，活动 `7d`）。
 * 字段值格式化，不是界面文案；天数整除显示，不产出积分值。
 */
export function remainingLabel(task: Task, now: Date): string {
  if (task.type !== 'deadline' && task.type !== 'event') return ''
  if (!task.dueAt) return ''
  const dueTime = new Date(task.dueAt).getTime()
  if (Number.isNaN(dueTime)) return ''
  const diffHours = (dueTime - now.getTime()) / 3600000
  if (diffHours < 0) return '逾期'
  if (diffHours < 24) return `${Math.max(1, Math.floor(diffHours))}h`
  if (task.type === 'deadline') {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    if (localDayOf(new Date(dueTime)) === localDayOf(tomorrow)) return '明天'
  }
  return `${Math.floor(diffHours / 24)}d`
}

/** 步骤是否已勾（勾选 = 状态离开 todo；完成语义归 W6/W7，见 useTasksData 注释） */
export function isStepChecked(step: Task): boolean {
  return step.status !== 'todo'
}
