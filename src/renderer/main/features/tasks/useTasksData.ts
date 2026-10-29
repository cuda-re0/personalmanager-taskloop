import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DomainEvent } from '@shared/types/events'
import type { Occurrence, Task, TaskPatch, TaskStatus, TaskType } from '@shared/types/domain'
import { toLocalDay as localDayOf } from '@shared/localDay'
import { isStepChecked } from './tasksModel'
import { onFocusTask } from './focusTask'

/**
 * 右栏①「当前任务」的数据入口。
 *
 * 首载走 `task.list`（含子任务）+ `occurrence.today`，之后靠 DomainEvent 增量：
 * 任何 task.* 事件（created / updated / removed）都重拉列表——单窗口、列表量级小，
 * 重拉比维护一套本地 diff 简单且不会漂；occurrence.created / updated 按 id upsert。
 *
 * 通道边界（W6 起）：
 * - 步骤勾选 → `task.transition`（todo ↔ doing，只改子任务）。
 * - [完成] → 先 `task.transition({to:'reviewing'})` 提交，再 `task.complete({quality:'met'})`。
 *   **done 只能从 reviewing 进入**（01 §3），而 `task.complete` 是唯一写 `completed_at` +
 *   ledger 的入口（02 §3.2）；两步都用已接通的通道，不碰 `transition({to:'done'})`（恒 409）。
 * - [直接标记完成（不计分）] → `task.complete({ noPoints: true })`，`entry` 返回 null。
 * - 每日组的圆形勾选框 → `occurrence.complete`（每日任务不进 done，状态在 occurrence 上）。
 * - 拖动排序 → `task.reorder`（sortKey 落库，重启保持）。
 * - `task.update` / `task.setReminderOffsets`：04 §4① 的详情区没有对应编辑入口
 *   （提醒偏移只读展示，增删偏移是 W8 交付 9），无可接线处，通道接线随编辑器落地。
 * - `taskloop:focus-task`（W6B 日历浮层 / ④ 明细点行）→ 展开 + 滚动 + 短暂高亮。
 */

const ACTIVE_STATUS: TaskStatus[] = ['todo', 'doing', 'reviewing']

/**
 * 只收今天的 occurrence（v0.21）。
 *
 * 这份 state 的语义是**今日列表**，但 `occurrence.created` 是通用事件——
 * 只要载荷里带了未来日期（`ensureRange(今天,+3天)` 的预生成），无脑合并就会让
 * 「每日」组出现同名多行，用户会把未来几天逐个点掉（提前打卡 + 白拿分 + 污染 streak）。
 * 主进程侧已经收窄了 promoteDraft 的广播；这里再守一道，因为事件通道对任何调用方开放。
 */
function mergeTodayOccurrences(prev: Occurrence[], incoming: Occurrence[]): Occurrence[] {
  const today = localDayOf(new Date())
  const map = new Map(
    prev.filter(o => o.day === today).map(o => [o.id, o] as const)
  )
  for (const o of incoming) if (o.day === today) map.set(o.id, o)
  return [...map.values()]
}

export interface TasksActions {
  /** 点击行：展开/收起详情（就地展开，不弹窗） */
  expand(taskId: string): void
  /** 步骤勾选：只改子任务状态（todo ↔ doing），不影响父任务（04 §4①） */
  toggleStep(step: Task): void
  /** [完成]：还有未勾步骤时弹就地确认条，否则直接提交并计分 */
  completeTask(task: Task): void
  /** 确认条上的 [完成]（计分，quality='met'） */
  confirmComplete(task: Task): void
  /** 确认条上的 [直接标记完成（不计分）] */
  confirmCompleteNoPoints(task: Task): void
  /** 每日组的圆形勾选框 → occurrence.complete */
  completeOccurrence(occurrenceId: string): void
  /** 确认条上的 [继续做] */
  cancelComplete(): void
  /** 拖动排序：放到 beforeId 之前，null = 末尾 */
  reorder(taskId: string, beforeId: string | null): void
  /** 右栏① 顶部「+」手动建任务（v0.21）。成功返回 true，表单据此收起 */
  createManual(input: { type: TaskType; title: string; patch?: TaskPatch }): Promise<boolean>
}

export interface TasksData {
  tasks: Task[]
  occurrences: Occurrence[]
  /** 父任务 id → 子步骤（展开详情用） */
  subtasksByParent: Map<string, Task[]>
  expandedId: string | null
  /** 正在显示就地确认条的任务 id */
  confirmId: string | null
  /** focus-task 高亮的任务 id（1.2s 后自动清空） */
  focusId: string | null
  /** 该任务行内的失败红字（v0.24）；按 taskId 匹配，不叠多行 */
  notice: { taskId: string; message: string } | null
  actions: TasksActions
}

/** 行内红字的停留时长（04 §4① v0.24） */
const NOTICE_MS = 2600

export function useTasksData(): TasksData {
  const [tasks, setTasks] = useState<Task[]>([])
  const [occurrences, setOccurrences] = useState<Occurrence[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ taskId: string; message: string } | null>(null)
  const noticeTimer = useRef<number | null>(null)
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
          setOccurrences(prev => mergeTodayOccurrences(prev, e.occurrences))
          break
        case 'occurrence.updated':
          setOccurrences(prev => mergeTodayOccurrences(prev, [e.occurrence]))
          break
        default:
          break
      }
    })
    return off
  }, [reloadTasks, reloadOccurrences])

  /** focus-task（W6B 日历浮层 / ④ 明细点行）：展开该任务并高亮 */
  useEffect(
    () =>
      onFocusTask(id => {
        setExpandedId(id)
        setConfirmId(null)
        setFocusId(id)
      }),
    []
  )

  useEffect(() => {
    if (focusId === null) return
    const target = document.querySelector(`[data-task-id="${focusId}"]`)
    if (target instanceof HTMLElement) target.scrollIntoView({ block: 'nearest' })
    const timer = window.setTimeout(() => setFocusId(null), 1200)
    return () => window.clearTimeout(timer)
  }, [focusId])

  /**
   * 行内红字自动消失（04 §4① v0.24）。
   *
   * 定时器跟着 `notice` 变：同一任务连续失败只会重置计时（新对象 → effect 重跑 → 先清旧的），
   * 不叠加多行。StrictMode 下 effect 跑两次也安全——「先清后设」。
   */
  useEffect(() => {
    if (notice === null) return
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, NOTICE_MS)
    return () => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current)
        noticeTimer.current = null
      }
    }
  }, [notice])

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

  /**
   * 提交 + 完成（02 §3.2 / 01 §3）。
   *
   * 先 `transition('reviewing')`（同状态时是幂等 no-op，不会 409），再走唯一完成入口
   * `task.complete`。两步分开调是刻意的：完成需要 `reviewing` 这个前置状态，
   * 而 `task.complete` 内部要保证「状态 + 入账 + 统计」同事务，不该由渲染层拼事务。
   * 证据不足时第二步返回 EVIDENCE_REQUIRED（02 §1/§3.2），任务就停在「待确认」——
   * 这正是 01 §3 要的语义；出口是确认条上的「直接标记完成（不计分）」。
   */
  const submitAndComplete = useCallback((task: Task, noPoints: boolean): void => {
    void window.api.task
      .transition({ id: task.id, to: 'reviewing' })
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] 提交完成失败', res.error)
          // 行内红字用主进程文案原样（04 §4① v0.24），不在这里另写句子
          setNotice({ taskId: task.id, message: res.error.message })
          return
        }
        const complete = noPoints
          ? window.api.task.complete({ id: task.id, noPoints: true })
          : window.api.task.complete({ id: task.id, quality: 'met' })
        void complete
          .then(done => {
            if (!done.ok) {
              console.error('[tasks] task.complete 失败', done.error)
              // 典型：requires_evidence=1 且没附证据 → EVIDENCE_REQUIRED「证据不能为空」
              setNotice({ taskId: task.id, message: done.error.message })
            }
            // 成功后的刷新走 task.updated / points.changed 事件
          })
          .catch((e: unknown) => console.error('[tasks] task.complete 调用失败', e))
      })
      .catch((e: unknown) => console.error('[tasks] task.transition 调用失败', e))
  }, [])

  const completeTask = useCallback(
    (task: Task): void => {
      const steps = subtasksByParent.get(task.id) ?? []
      if (steps.some(s => !isStepChecked(s))) {
        // 还有未勾步骤：就地确认条（04 §4①），不是 modal
        setConfirmId(task.id)
        return
      }
      submitAndComplete(task, false)
    },
    [subtasksByParent, submitAndComplete]
  )

  const confirmComplete = useCallback(
    (task: Task): void => {
      setConfirmId(null)
      submitAndComplete(task, false)
    },
    [submitAndComplete]
  )

  const confirmCompleteNoPoints = useCallback(
    (task: Task): void => {
      setConfirmId(null)
      submitAndComplete(task, true)
    },
    [submitAndComplete]
  )

  const completeOccurrence = useCallback((occurrenceId: string): void => {
    void window.api.occurrence
      .complete({ id: occurrenceId })
      .then(res => {
        if (!res.ok) console.error('[tasks] occurrence.complete 失败', res.error)
      })
      .catch((e: unknown) => console.error('[tasks] occurrence.complete 调用失败', e))
  }, [])

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

  /**
   * 手动建任务（v0.21）。
   *
   * 只走 `task.createManual` 一条通道：`type` 在顶层、其余条件塞 `patch`（02 §1 的入参形状）。
   * 成功后不做本地插入——`task.created` 事件会把列表重拉一遍；每日任务今天的 occurrence
   * 由主进程 `createTask` 自己 ensure，渲染层不补。
   */
  const createManual = useCallback(
    (input: { type: TaskType; title: string; patch?: TaskPatch }): Promise<boolean> =>
      window.api.task
        .createManual(input)
        .then(res => {
          if (!res.ok) {
            console.error('[tasks] task.createManual 失败', res.error)
            return false
          }
          return true
        })
        .catch((e: unknown) => {
          console.error('[tasks] task.createManual 调用失败', e)
          return false
        }),
    []
  )

  const actions = useMemo<TasksActions>(
    () => ({
      expand,
      toggleStep,
      completeTask,
      confirmComplete,
      confirmCompleteNoPoints,
      completeOccurrence,
      cancelComplete,
      reorder,
      createManual
    }),
    [
      expand,
      toggleStep,
      completeTask,
      confirmComplete,
      confirmCompleteNoPoints,
      completeOccurrence,
      cancelComplete,
      reorder,
      createManual
    ]
  )

  return {
    tasks,
    occurrences,
    subtasksByParent,
    expandedId,
    confirmId,
    focusId,
    notice,
    actions
  }
}
