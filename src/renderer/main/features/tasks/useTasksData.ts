import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DomainEvent } from '@shared/types/events'
import type { Occurrence, Task, TaskPatch, TaskStatus, TaskType } from '@shared/types/domain'
import { toLocalDay as localDayOf } from '@shared/localDay'
import { isDoneToday, isMissedToday, isStepChecked } from './tasksModel'
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
 * - [完成] → `task.transition({to:'pending_review'})`，**到此为止**（v0.38）：任务进「待提交」，
 *   会话末尾出待提交卡，用户交材料后点提交才 `transition({to:'reviewing'})` 并送审
 *   （送审与分流在 `reviewFlow.submitForReview` / `runReview`，本文件不再直接调）。
 *   不计分直通仍走 `transition('reviewing')` + `task.complete({ noPoints: true })`——
 *   **done 只能从 reviewing 进入**（01 §3），而 `task.complete` 是唯一写 `completed_at` +
 *   ledger 的入口（02 §3.2）；全程不碰 `transition({to:'done'})`（恒 409）。
 * - [直接标记完成（不计分）] → `task.complete({ noPoints: true })`，`entry` 返回 null。
 * - 每日组的圆形勾选框 → `occurrence.complete`（每日任务不进 done，状态在 occurrence 上）。
 * - 拖动排序 → `task.reorder`（sortKey 落库，重启保持）。
 * - `task.update` / `task.setReminderOffsets`：04 §4① 的详情区没有对应编辑入口
 *   （提醒偏移只读展示，增删偏移是 W8 交付 9），无可接线处，通道接线随编辑器落地。
 * - `taskloop:focus-task`（W6B 日历浮层 / ④ 明细点行）→ 展开 + 滚动 + 短暂高亮。
 */

const ACTIVE_STATUS: TaskStatus[] = ['todo', 'doing', 'pending_review', 'reviewing']

/** 今日已完成行的拉取状态（v0.27：done 且今天完成的保留、变淡、沉底，第二天自然消失） */
const DONE_STATUS: TaskStatus[] = ['done']

/** 今日被判失败的行（v0.34）：没有 completedAt，按 updatedAt 落在今天过滤 */
const MISSED_STATUS: TaskStatus[] = ['missed']

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
  /** 今日已完成的顶层任务（v0.27）：done 且 completedAt 是今天，行保留、变淡、沉底 */
  doneTasks: Task[]
  /** 今日被判失败的顶层任务（v0.34）：missed 且 updatedAt 是今天，与 done 同档渲染 */
  missedTasks: Task[]
  /** 正在点完成（transition 在飞，期间 [完成] 与确认条按钮禁用，防止重复发请求）；v0.38 起不再含「审核中」 */
  reviewingIds: ReadonlySet<string>
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
  const [doneTasks, setDoneTasks] = useState<Task[]>([])
  const [missedTasks, setMissedTasks] = useState<Task[]>([])
  const [reviewingIds, setReviewingIds] = useState<ReadonlySet<string>>(() => new Set())
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

  /**
   * 今日已完成的顶层任务（v0.27）。通道过滤只到 status='done'，「completedAt 是今天」
   * 在渲染层过滤（现成通道，不动 repo）；明天这条过滤自然为空，行自动消失。
   */
  const reloadDoneTasks = useCallback(() => {
    void window.api.task
      .list({ status: DONE_STATUS })
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] task.list(done) 失败', res.error)
          return
        }
        const today = localDayOf(new Date())
        setDoneTasks(res.data.filter(t => isDoneToday(t, today)))
      })
      .catch((e: unknown) => console.error('[tasks] task.list(done) 调用失败', e))
  }, [])

  /**
   * 今日被判失败的任务（v0.34）。`missed` 没有 `completedAt`（不是用户完成的，
   * 是审核驳回时判的），所以按 `updatedAt` 落在今天过滤——明天这条过滤自然为空，
   * 与 done 同一条「靠过滤消失」的口径，禁止任何清理或定时逻辑。
   */
  const reloadMissedTasks = useCallback(() => {
    void window.api.task
      .list({ status: MISSED_STATUS })
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] task.list(missed) 失败', res.error)
          return
        }
        const today = localDayOf(new Date())
        setMissedTasks(res.data.filter(t => isMissedToday(t, today)))
      })
      .catch((e: unknown) => console.error('[tasks] task.list(missed) 调用失败', e))
  }, [])

  useEffect(() => {
    reloadTasks()
    reloadOccurrences()
    reloadDoneTasks()
    reloadMissedTasks()
    const off = window.api.onEvent((e: DomainEvent) => {
      switch (e.type) {
        case 'task.created':
          // 兜底（23 号开工词）：任何「建 daily 的入口」漏了补行，界面都能自愈一次；
          // task.updated / task.removed 不加——每次改任务都多打一次 IPC，没必要
          reloadTasks()
          reloadOccurrences()
          break
        case 'task.updated':
        case 'task.removed':
          // 完成会把任务挪进 done 集合，驳回超期会挪进 missed 集合，两路都要跟着重拉
          reloadTasks()
          reloadDoneTasks()
          reloadMissedTasks()
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
  }, [reloadTasks, reloadOccurrences, reloadDoneTasks, reloadMissedTasks])

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
   * 提交完成（02 §3.2 / 01 §3 / v0.38）。
   *
   * **计分路径只做一步**：`transition({to:'pending_review'})`。任务进「待提交」，会话末尾
   * 出现待提交卡，等用户交材料再点提交才送审（送审与分流在 `reviewFlow.submitForReview`）。
   * v0.34~v0.36 的「点完成立即 `runReview`」在这里删掉了——那条路没有让用户交材料的窗口，
   * 而且手动建的限时任务 `requires_evidence` 恒 false，等于什么都不交就能拿满分。
   *
   * 不计分直通（确认条上的「直接标记完成（不计分）」）**不送审也不待提交**：免分数逃生口，
   * `transition('reviewing')` 后直接 `task.complete({ noPoints: true })`，不加分、不调 ai.review。
   */
  const submitAndComplete = useCallback((task: Task, noPoints: boolean): void => {
    if (noPoints) {
      void window.api.task
        .transition({ id: task.id, to: 'reviewing' })
        .then(res => {
          if (!res.ok) {
            console.error('[tasks] 提交完成失败', res.error)
            // 行内红字用主进程文案原样（04 §4① v0.24），不在这里另写句子
            setNotice({ taskId: task.id, message: res.error.message })
            return
          }
          void window.api.task
            .complete({ id: task.id, noPoints: true })
            .then(done => {
              if (!done.ok) {
                console.error('[tasks] task.complete(noPoints) 失败', done.error)
                setNotice({ taskId: task.id, message: done.error.message })
              }
              // 成功后的刷新走 task.updated / points.changed 事件
            })
            .catch((e: unknown) => console.error('[tasks] task.complete 调用失败', e))
        })
        .catch((e: unknown) => console.error('[tasks] task.transition 调用失败', e))
      return
    }

    // 送审前的落点在 transition 那一瞬：先占住按钮，成功后释放（状态已变成 pending_review，
    // [完成] 也随之消失；失败则把错误原文塞进行内红字）。
    setReviewingIds(prev => {
      const next = new Set(prev)
      next.add(task.id)
      return next
    })
    void window.api.task
      .transition({ id: task.id, to: 'pending_review' })
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] 提交完成失败', res.error)
          setNotice({ taskId: task.id, message: res.error.message })
        }
        // 成功后的刷新走 task.updated 事件（列表 + 会话区的待提交卡都靠它）
      })
      .catch((e: unknown) => console.error('[tasks] task.transition 调用失败', e))
      .finally(() => {
        setReviewingIds(prev => {
          if (!prev.has(task.id)) return prev
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      })
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
    doneTasks,
    missedTasks,
    reviewingIds,
    occurrences,
    subtasksByParent,
    expandedId,
    confirmId,
    focusId,
    notice,
    actions
  }
}
