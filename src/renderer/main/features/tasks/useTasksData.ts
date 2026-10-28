import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DomainEvent } from '@shared/types/events'
import type { Occurrence, Task, TaskStatus } from '@shared/types/domain'
import { isStepChecked } from './tasksModel'

/**
 * 右栏①「当前任务」的数据入口。
 *
 * 首载走 `task.list`（含子任务）+ `occurrence.today`，之后靠 DomainEvent 增量：
 * 任何 task.* 事件（created / updated / removed）都重拉列表——单窗口、列表量级小，
 * 重拉比维护一套本地 diff 简单且不会漂；occurrence.created / updated 按 id upsert。
 *
 * 通道边界（W5）：
 * - 步骤勾选 / [完成] → `task.transition`（[完成] 语义 = 提交完成 → reviewing，开工词红线 3；
 *   `transition({to:'done'})` 恒 409，`task.complete` 是 W6 的通道、未注册，不调）。
 * - 拖动排序 → `task.reorder`（sortKey 落库，重启保持）。
 * - `task.update` / `task.setReminderOffsets`：04 §4① 的详情区没有对应编辑入口
 *   （提醒偏移只读展示，增删偏移是 W8 交付 9），无可接线处，通道接线随编辑器落地。
 * - 每日组的圆形勾选框只渲染视觉（04 §4①），完成动作是 `occurrence.complete`
 *   （W6 的通道、未注册），W6 接线前点击无动作。
 */

const ACTIVE_STATUS: TaskStatus[] = ['todo', 'doing', 'reviewing']

function mergeOccurrences(prev: Occurrence[], incoming: Occurrence[]): Occurrence[] {
  const map = new Map(prev.map(o => [o.id, o]))
  for (const o of incoming) map.set(o.id, o)
  return [...map.values()]
}

export interface TasksActions {
  /** 点击行：展开/收起详情（就地展开，不弹窗） */
  expand(taskId: string): void
  /** 步骤勾选：只改子任务状态（todo ↔ doing），不影响父任务（04 §4①） */
  toggleStep(step: Task): void
  /** [完成]：还有未勾步骤时弹就地确认条，否则直接提交 */
  completeTask(task: Task): void
  /** 确认条上的 [完成] */
  confirmComplete(task: Task): void
  /** 确认条上的 [继续做] */
  cancelComplete(): void
  /** 拖动排序：放到 beforeId 之前，null = 末尾 */
  reorder(taskId: string, beforeId: string | null): void
}

export interface TasksData {
  tasks: Task[]
  occurrences: Occurrence[]
  /** 父任务 id → 子步骤（展开详情用） */
  subtasksByParent: Map<string, Task[]>
  expandedId: string | null
  /** 正在显示就地确认条的任务 id */
  confirmId: string | null
  actions: TasksActions
}

export function useTasksData(): TasksData {
  const [tasks, setTasks] = useState<Task[]>([])
  const [occurrences, setOccurrences] = useState<Occurrence[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const reloadSeq = useRef(0)

  const reloadTasks = useCallback(() => {
    const seq = reloadSeq.current + 1
    reloadSeq.current = seq
    void window.api.task
      .list({ status: ACTIVE_STATUS, includeSubtasks: true })
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] task.list 失败', res.error)
          return
        }
        if (seq === reloadSeq.current) setTasks(res.data)
      })
      .catch((e: unknown) => console.error('[tasks] task.list 调用失败', e))
  }, [])

  const reloadOccurrences = useCallback(() => {
    void window.api.occurrence
      .today()
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] occurrence.today 失败', res.error)
          return
        }
        setOccurrences(res.data)
      })
      .catch((e: unknown) => console.error('[tasks] occurrence.today 调用失败', e))
  }, [])

  useEffect(() => {
    reloadTasks()
    reloadOccurrences()
    const off = window.api.onEvent((e: DomainEvent) => {
      switch (e.type) {
        case 'task.created':
        case 'task.updated':
        case 'task.removed':
          reloadTasks()
          break
        case 'occurrence.created':
          setOccurrences(prev => mergeOccurrences(prev, e.occurrences))
          break
        case 'occurrence.updated':
          setOccurrences(prev => mergeOccurrences(prev, [e.occurrence]))
          break
        default:
          break
      }
    })
    return off
  }, [reloadTasks, reloadOccurrences])

  /** 按父任务分组的子步骤 */
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (t.parentId === null) continue
      const list = map.get(t.parentId) ?? []
      list.push(t)
      map.set(t.parentId, list)
    }
    return map
  }, [tasks])

  const transition = useCallback((id: string, to: TaskStatus): void => {
    void window.api.task
      .transition({ id, to })
      .then(res => {
        if (!res.ok) console.error('[tasks] task.transition 失败', res.error)
        // 成功后的刷新走 task.updated 事件
      })
      .catch((e: unknown) => console.error('[tasks] task.transition 调用失败', e))
  }, [])

  const expand = useCallback((taskId: string): void => {
    setExpandedId(prev => (prev === taskId ? null : taskId))
    setConfirmId(null)
  }, [])

  const completeTask = useCallback(
    (task: Task): void => {
      const steps = subtasksByParent.get(task.id) ?? []
      if (steps.some(s => !isStepChecked(s))) {
        // 还有未勾步骤：就地确认条（04 §4①），不是 modal
        setConfirmId(task.id)
        return
      }
      transition(task.id, 'reviewing')
    },
    [subtasksByParent, transition]
  )

  const confirmComplete = useCallback(
    (task: Task): void => {
      setConfirmId(null)
      transition(task.id, 'reviewing')
    },
    [transition]
  )

  const cancelComplete = useCallback((): void => {
    setConfirmId(null)
  }, [])

  const toggleStep = useCallback(
    (step: Task): void => {
      transition(step.id, step.status === 'todo' ? 'doing' : 'todo')
    },
    [transition]
  )

  const reorder = useCallback((taskId: string, beforeId: string | null): void => {
    void window.api.task
      .reorder({ id: taskId, beforeId })
      .then(res => {
        if (!res.ok) console.error('[tasks] task.reorder 失败', res.error)
      })
      .catch((e: unknown) => console.error('[tasks] task.reorder 调用失败', e))
  }, [])

  const actions = useMemo<TasksActions>(
    () => ({ expand, toggleStep, completeTask, confirmComplete, cancelComplete, reorder }),
    [expand, toggleStep, completeTask, confirmComplete, cancelComplete, reorder]
  )

  return { tasks, occurrences, subtasksByParent, expandedId, confirmId, actions }
}
