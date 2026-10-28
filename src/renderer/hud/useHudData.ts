import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Occurrence, Task } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import type { HudMode } from '@shared/types/ipc'
import {
  buildRows,
  localDayOf,
  pendingCount,
  recentTitle,
  type HudRow
} from './hudModel'

/**
 * HUD 的数据入口（04 §5.5）。
 *
 * 唯一来源是 `app.getBootstrap` + `DomainEvent` 增量——**不读主窗的组件状态/全局 store**
 * （两个渲染进程各自独立）。所有写入都走已接通的通道，成功后不做本地乐观更新：
 * 主进程的广播会把增量推回来，界面因此永远显示落库后的真值。
 *
 * 100ms 达标路径（验收 1）：`task.complete` → `points.changed` + `daystats.changed`；
 * `occurrence.complete` → `occurrence.updated` + `points.changed`。都是事件推送，没有轮询。
 */

const ACTIVE_STATUS = new Set(['todo', 'doing', 'reviewing'])
/** 轻提示停留时长：错误 `message` 原样展示，够看清即可 */
const ERROR_TTL_MS = 4000

interface Snapshot {
  ready: boolean
  mode: HudMode
  expanded: boolean
  occurrences: Occurrence[]
  tasks: Task[]
  /** 今日积分：只来自 `bootstrap.today.points` / `points.changed.today` / `daystats.changed` */
  points: number
}

const EMPTY: Snapshot = {
  ready: false,
  mode: 'dock-bar',
  expanded: false,
  occurrences: [],
  tasks: [],
  points: 0
}

export interface HudActions {
  /** 展开/收起（dock-bar 的 hover 计时、float-pod 的点击/ESC 都调它） */
  setExpanded(expanded: boolean): void
  /** 切换形态（`⋯` 按钮）：主进程换 bounds + 广播，窗口不重建 */
  switchMode(): void
  /** 勾一行：每日 → `occurrence.complete`；限时/活动 → 提交后 `task.complete` */
  completeRow(row: HudRow): void
  /** 一句话加任务：`task.createManual`（deadline / medium / 无 due_at）。成功返回 true，调用方可清空输入 */
  addTask(title: string): Promise<boolean>
}

export interface HudData {
  ready: boolean
  mode: HudMode
  expanded: boolean
  /** 今日打卡完成数 / 应打卡数 */
  done: number
  total: number
  points: number
  rows: HudRow[]
  /** 收起态 dock-bar 右侧的标题 */
  recentTitle: string | null
  /** float-pod 角标 */
  pending: number
  /** 轻提示：`AppError.message` 原样（04 §1.1 登记过的串） */
  error: string | null
  actions: HudActions
}

function upsertOccurrences(list: Occurrence[], incoming: Occurrence[]): Occurrence[] {
  const map = new Map(list.map(o => [o.id, o]))
  for (const o of incoming) {
    // `occurrence.complete/undo/skip` 推的是裸行（无联表字段），`taskTitle` 会被覆盖成 undefined
    // → HUD 列表会变成空白行。这里保留上一个已知标题与类型（同 id 同任务，不会串）。
    const prev = map.get(o.id)
    map.set(o.id, {
      ...o,
      taskTitle: o.taskTitle ?? prev?.taskTitle,
      taskType: o.taskType ?? prev?.taskType
    })
  }
  return [...map.values()]
}

function upsertTask(list: Task[], task: Task): Task[] {
  const index = list.findIndex(t => t.id === task.id)
  // 已完成/丢弃/归档的任务不在 HUD 列表里（bootstrap 的 tasks 也只给活跃三条状态）
  if (!ACTIVE_STATUS.has(task.status)) {
    return index >= 0 ? list.filter(t => t.id !== task.id) : list
  }
  if (index < 0) return [...list, task]
  const next = [...list]
  next[index] = task
  return next
}

export function useHudData(): HudData {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showError = useCallback((message: string): void => {
    setError(message)
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => setError(null), ERROR_TTL_MS)
  }, [])

  useEffect(() => {
    let alive = true

    const handleEvent = (event: DomainEvent): void => {
      setSnapshot(prev => {
        switch (event.type) {
          case 'occurrence.created':
            return { ...prev, occurrences: upsertOccurrences(prev.occurrences, event.occurrences) }
          case 'occurrence.updated':
            return {
              ...prev,
              occurrences: upsertOccurrences(prev.occurrences, [event.occurrence])
            }
          case 'task.created':
          case 'task.updated':
            return { ...prev, tasks: upsertTask(prev.tasks, event.task) }
          case 'task.removed':
            return { ...prev, tasks: prev.tasks.filter(t => t.id !== event.taskId) }
          case 'points.changed':
            // 载荷里的 `today` 已经是主进程算好的当日统计，直接取用（不自己求和）
            return { ...prev, points: event.today.points }
          case 'daystats.changed':
            // 日历补做往日任务会推那一天的统计，只有今天才覆盖"HUD 今日积分"
            return event.day.day === localDayOf(new Date())
              ? { ...prev, points: event.day.points }
              : prev
          case 'hud.mode.changed':
            return { ...prev, mode: event.mode }
          default:
            return prev
        }
      })
    }

    const off = window.api.onEvent(handleEvent)

    void Promise.all([window.api.hud.getState(), window.api.app.getBootstrap()])
      .then(([state, bootstrap]) => {
        if (!alive) return
        if (!state.ok) {
          console.error('[hud] hud.getState 失败', state.error)
          return
        }
        if (!bootstrap.ok) {
          console.error('[hud] app.getBootstrap 失败', bootstrap.error)
          return
        }
        const { tasks, todayOccurrences, today } = bootstrap.data
        setSnapshot({
          ready: true,
          // 形态与展开态以窗口状态为准（settings 里的是上次落库值，可能还没同步到窗口）
          mode: state.data.mode,
          expanded: state.data.expanded,
          occurrences: todayOccurrences,
          tasks,
          points: today.points
        })
      })
      .catch((e: unknown) => console.error('[hud] 首载失败', e))

    return () => {
      alive = false
      off()
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  /**
   * 用主进程的真值覆盖 `mode` / `expanded`。
   * 切换形态时**必须**重新取一次：展开态是按模式各记一份的（`hud.expanded`），
   * `hud.mode.changed` 只带 `mode`，本地若沿用旧展开态就会与窗口实际高度对不上
   * （260px 的窗口里塞一个收起态外壳，或者反过来）。同理，IPC 失败时也靠它回弹。
   */
  const refreshWindowState = useCallback((): void => {
    void window.api.hud
      .getState()
      .then(res => {
        if (!res.ok) {
          console.error('[hud] hud.getState 失败', res.error)
          return
        }
        setSnapshot(prev => ({ ...prev, mode: res.data.mode, expanded: res.data.expanded }))
      })
      .catch((e: unknown) => console.error('[hud] hud.getState 调用失败', e))
  }, [])

  const setExpanded = useCallback(
    (expanded: boolean): void => {
      setSnapshot(prev => (prev.expanded === expanded ? prev : { ...prev, expanded }))
      void window.api.hud
        .setExpanded({ expanded })
        .then(res => {
          if (!res.ok) {
            console.error('[hud] hud.setExpanded 失败', res.error)
            refreshWindowState()
          }
        })
        .catch((e: unknown) => console.error('[hud] hud.setExpanded 调用失败', e))
    },
    [refreshWindowState]
  )

  const switchMode = useCallback((): void => {
    const mode: HudMode = snapshot.mode === 'dock-bar' ? 'float-pod' : 'dock-bar'
    setSnapshot(prev => ({ ...prev, mode }))
    // 换 bounds + 广播 hud.mode.changed 在主进程（04 §5.4），窗口不重建
    void window.api.hud
      .setMode({ mode })
      .then(res => {
        if (!res.ok) {
          console.error('[hud] hud.setMode 失败', res.error)
          refreshWindowState()
          return
        }
        refreshWindowState()
      })
      .catch((e: unknown) => console.error('[hud] hud.setMode 调用失败', e))
  }, [snapshot.mode, refreshWindowState])

  const completeRow = useCallback(
    (row: HudRow): void => {
      if (row.done) return
      if (row.kind === 'occurrence') {
        void window.api.occurrence
          .complete({ id: row.id })
          .then(res => {
            if (!res.ok) showError(res.error.message)
          })
          .catch((e: unknown) => console.error('[hud] occurrence.complete 调用失败', e))
        return
      }
      // 与 W6 右栏 [完成（计分）] 同一条路径：done 只能从 reviewing 进入（01 §3），
      // 所以先 transition 再 complete，参数 quality='met'
      void window.api.task
        .transition({ id: row.id, to: 'reviewing' })
        .then(res => {
          if (!res.ok) {
            showError(res.error.message)
            return undefined
          }
          return window.api.task.complete({ id: row.id, quality: 'met' }).then(done => {
            if (!done.ok) showError(done.error.message)
          })
        })
        .catch((e: unknown) => console.error('[hud] task.complete 调用失败', e))
    },
    [showError]
  )

  const addTask = useCallback(
    (title: string): Promise<boolean> => {
      const text = title.trim()
      if (text.length === 0) return Promise.resolve(false)
      return window.api.task
        .createManual({ type: 'deadline', title: text, patch: { difficulty: 'medium' } })
        .then(res => {
          if (!res.ok) {
            showError(res.error.message)
            return false
          }
          return true
        })
        .catch((e: unknown) => {
          console.error('[hud] task.createManual 调用失败', e)
          return false
        })
    },
    [showError]
  )

  const rows = useMemo(
    () => buildRows(snapshot.occurrences, snapshot.tasks),
    [snapshot.occurrences, snapshot.tasks]
  )
  const done = snapshot.occurrences.filter(o => o.status === 'done').length
  const total = snapshot.occurrences.length

  return {
    ready: snapshot.ready,
    mode: snapshot.mode,
    expanded: snapshot.expanded,
    done,
    total,
    points: snapshot.points,
    rows,
    recentTitle: recentTitle(rows),
    pending: pendingCount(snapshot.occurrences, snapshot.tasks),
    error,
    actions: { setExpanded, switchMode, completeRow, addTask }
  }
}
