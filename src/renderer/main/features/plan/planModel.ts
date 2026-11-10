import type { Task } from '@shared/types/domain'

/**
 * 计划面板的数据整形（92a §2.1）。
 *
 * 这是**只读视图**的分组：只回答「哪一天排了哪些事」，不改任何任务、不改入参数组。
 * 特别地，这里**不做**任何「顺延到今天」「滚动搬运」的逻辑——计划日在昨天而没做完的，
 * 就留在昨天那一组；已完成 / 已判失败的条目也照常留在原来那一天，不移动、不隐藏
 * （灰掉是渲染层的事，见 `PlanView`）。
 *
 * 纯函数：只 import `Task` 类型，不引 react / electron / db，也不读时钟。
 */

export interface PlanDayGroup {
  day: string
  tasks: Task[]
}

/** 组内三级排序：sortKey → createdAt → id，三级都相同才算并列（保证结果稳定） */
function comparePlanRows(a: Task, b: Task): number {
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey
  // createdAt 一律是 ISO8601 UTC（`nowIso()`），字典序即时间序
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

export function groupByPlanDay(tasks: Task[]): PlanDayGroup[] {
  // 子步骤（父任务的 steps 落成的子任务）不进计划视图：它们是父任务的内部拆解，
  // 单列出来会让同一天的条目数翻倍，而它们本来就不单独执行
  const picked = tasks.filter(t => t.plannedDay !== null && t.parentId === null)

  const byDay = new Map<string, Task[]>()
  for (const task of picked) {
    const day = task.plannedDay as string
    const bucket = byDay.get(day)
    if (bucket === undefined) byDay.set(day, [task])
    else bucket.push(task)
  }

  // 两边都是 `YYYY-MM-DD`，字符串字典序即日期序——转 `Date` 会把时区带进来，
  // 东八区 00:00–08:00 会整片串到前一天
  return [...byDay.entries()]
    .sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1))
    .map(([day, list]) => ({ day, tasks: [...list].sort(comparePlanRows) }))
}
