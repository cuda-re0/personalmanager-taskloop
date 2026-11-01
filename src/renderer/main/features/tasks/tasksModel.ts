import type { Occurrence, Task, TaskType } from '@shared/types/domain'
import { dueHasTime, dueInstant } from '@shared/due'
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
 * 字段值格式化，不是界面文案；天数整除显示，不产出积分值。
 */
export function remainingLabel(task: Task, now: Date): string {
  if (task.type !== 'deadline' && task.type !== 'event') return ''
  if (!task.dueAt) return ''
  const due = dueInstant(task.dueAt)
  if (due === null) return ''
  const diffHours = (due.getTime() - now.getTime()) / 3600000
  if (diffHours < 0) return '逾期'

  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = task.type === 'deadline' && localDayOf(due) === localDayOf(tomorrow)

  if (dueHasTime(task.dueAt)) {
    if (diffHours < 24) return `${Math.max(1, Math.floor(diffHours))}h`
    if (isTomorrow) return '明天'
    return `${Math.floor(diffHours / 24)}d`
  }

  // 没有具体时刻（day / month）：只按整天口径，不出现小时数——出现小时数等于替他编了个时刻
  if (isTomorrow) return '明天'
  return `${Math.max(1, Math.ceil(diffHours / 24))}d`
}

/** 步骤是否已勾（勾选 = 状态离开 todo；完成语义归 W6/W7，见 useTasksData 注释） */
export function isStepChecked(step: Task): boolean {
  return step.status !== 'todo'
}
