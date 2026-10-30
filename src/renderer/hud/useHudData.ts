import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Occurrence, Task } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import type { HudMode } from '@shared/types/ipc'
import { buildRows, composeHudBg, localDayOf, type HudRow } from './hudModel'

/**
 * HUD 的数据入口（04 §5.5）。
 *
 * 唯一来源是 `app.getBootstrap` + `DomainEvent` 增量——**不读主窗的组件状态/全局 store**
 * （两个渲染进程各自独立）。所有写入都走已接通的通道，成功后不做本地乐观更新：
 * 主进程的广播会把增量推回来，界面因此永远显示落库后的真值。
 *
 * 背景与透明度（v0.30）走 `app.setSetting`（`hud.background` / `hud.opacity`）。
 * 这两个值要求"即时生效"，所以先落本地状态再发 IPC：IPC 失败只进控制台，
 * 界面上的 `--hud-bg` 由 `app.setting.changed` 的回归值兜住。
 */

const ACTIVE_STATUS = new Set(['todo', 'doing', 'reviewing'])
/** 行内红字停留时长：`AppError.message` 原样展示，够看清即可（与主窗同口径） */
const ERROR_TTL_MS = 4000
const DEFAULT_THEME_BG = '#ffffff'

interface Snapshot {
  ready: boolean
  mode: HudMode
  occurrences: Occurrence[]
  tasks: Task[]
  /** 今日积分：只来自 `bootstrap.today.points` / `points.changed.today` / `daystats.changed` */
  points: number
  /** `hud.background`：null = 跟随主题 `--bg` */
  background: string | null
  /** `hud.opacity`：0.3–1 */
  opacity: number
}

const EMPTY: Snapshot = {
  ready: false,
  mode: 'ball',
  occurrences: [],
  tasks: [],
  points: 0,
  background: null,
  opacity: 1
}

/** 行内错误：哪一行 + `AppError.message` 原文 */
export interface HudRowError {
  rowId: string
  message: string
}

export interface HudActions {
  /** 手动切换形态：点球 → `panel`，ESC → `ball`（主进程换 bounds + 广播） */
  setMode(mode: HudMode): void
  /** 勾一行：每日 → `occurrence.complete`；限时/活动 → 先 reviewing 再 `task.complete` */
  completeRow(row: HudRow): void
  /** 一句话加任务：`task.createManual`（deadline / medium / 无 due_at）。成功返回 true */
  addTask(title: string): Promise<boolean>
  /** 背景色（`#rrggbb`）：即时生效 + 落 `hud.background` */
  setBackground(color: string): void
  /** 透明度 0.3–1：即时生效 + 落 `hud.opacity` */
  setOpacity(value: number): void
  /** 关闭悬浮窗（`hud.setVisible({ visible: false })`），回主窗顶栏可再打开 */
  close(): void
}

export interface HudData {
  ready: boolean
  mode: HudMode
  /** 今日打卡完成数 / 应打卡数 */
  done: number
  total: number
  points: number
  rows: HudRow[]
  /** 行内错误（`AppError.message` 原样，4s 消失） */
  rowError: HudRowError | null
  /** 合成好的背景（`rgba()`），直接写进 CSS 变量 `--hud-bg` */
  hudBg: string
  /** 设置页 `<input type="color">` 的值：`hud.background` 为空时取主题底色 */
  background: string
  opacity: number
  actions: HudActions
}

/** 主题底色（`--bg`）：`hud.background` 为 null 时用它合成 rgba */
function readThemeBg(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_BG
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  return value.length > 0 ? value : DEFAULT_THEME_BG
}

function upsertOccurrences(list: Occurrence[], incoming: Occurrence[]): Occurrence[] {
  // 只收今天（v0.21）：HUD 的 done/total 就是「今日打卡」，混进未来日期会把 0/1 显示成 0/4
  const today = localDayOf(new Date())
  const map = new Map(list.filter(o => o.day === today).map(o => [o.id, o] as const))
  for (const o of incoming) {
    if (o.day !== today) continue
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
  const [rowError, setRowError] = useState<HudRowError | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const themeBg = useMemo(readThemeBg, [])

  const showError = useCallback((rowId: string, message: string): void => {
    setRowError({ rowId, message })
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => setRowError(null), ERROR_TTL_MS)
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
          case 'app.setting.changed':
            if (event.key === 'hud.background') {
              return { ...prev, background: typeof event.value === 'string' ? event.value : null }
            }
            if (event.key === 'hud.opacity' && typeof event.value === 'number') {
              return { ...prev, opacity: event.value }
            }
            return prev
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
        const { tasks, todayOccurrences, today, settings } = bootstrap.data
        setSnapshot({
          ready: true,
          // 形态以窗口状态为准（settings 里的是上次落库值，可能还没同步到窗口）
          mode: state.data.mode,
          occurrences: todayOccurrences,
          tasks,
          points: today.points,
          background: settings['hud.background'],
          opacity: settings['hud.opacity']
        })
      })
      .catch((e: unknown) => console.error('[hud] 首载失败', e))

    return () => {
      alive = false
      off()
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  /** IPC 失败时用主进程真值回弹（形态可能已被主进程改过） */
  const refreshMode = useCallback((): void => {
    void window.api.hud
      .getState()
      .then(res => {
        if (!res.ok) {
          console.error('[hud] hud.getState 失败', res.error)
          return
        }
        setSnapshot(prev => ({ ...prev, mode: res.data.mode }))
      })
      .catch((e: unknown) => console.error('[hud] hud.getState 调用失败', e))
  }, [])

  const setMode = useCallback(
    (mode: HudMode): void => {
      setSnapshot(prev => (prev.mode === mode ? prev : { ...prev, mode }))
      // 换 bounds + 广播 hud.mode.changed 在主进程（04 §5.2），窗口不重建
      void window.api.hud
        .setMode({ mode })
        .then(res => {
          if (!res.ok) {
            console.error('[hud] hud.setMode 失败', res.error)
            refreshMode()
          }
        })
        .catch((e: unknown) => console.error('[hud] hud.setMode 调用失败', e))
    },
    [refreshMode]
  )

  const completeRow = useCallback(
    (row: HudRow): void => {
      if (row.done) return
      if (row.kind === 'occurrence') {
        void window.api.occurrence
          .complete({ id: row.id })
          .then(res => {
            if (!res.ok) showError(row.id, res.error.message)
          })
          .catch((e: unknown) => console.error('[hud] occurrence.complete 调用失败', e))
        return
      }
      // 与主窗 [完成（计分）] 同一条路径：done 只能从 reviewing 进入（01 §3），
      // 所以先 transition 再 complete，参数 quality='met'
      void window.api.task
        .transition({ id: row.id, to: 'reviewing' })
        .then(res => {
          if (!res.ok) {
            showError(row.id, res.error.message)
            return undefined
          }
          return window.api.task.complete({ id: row.id, quality: 'met' }).then(done => {
            if (!done.ok) showError(row.id, done.error.message)
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
            showError('add', res.error.message)
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

  const setBackground = useCallback((color: string): void => {
    setSnapshot(prev => ({ ...prev, background: color }))
    void window.api.app
      .setSetting({ key: 'hud.background', value: color })
      .then(res => {
        if (!res.ok) console.error('[hud] hud.background 写入失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] hud.background 写入失败', e))
  }, [])

  const setOpacity = useCallback((value: number): void => {
    setSnapshot(prev => ({ ...prev, opacity: value }))
    void window.api.app
      .setSetting({ key: 'hud.opacity', value })
      .then(res => {
        if (!res.ok) console.error('[hud] hud.opacity 写入失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] hud.opacity 写入失败', e))
  }, [])

  const close = useCallback((): void => {
    void window.api.hud
      .setVisible({ visible: false })
      .then(res => {
        if (!res.ok) console.error('[hud] hud.setVisible 失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] hud.setVisible 调用失败', e))
  }, [])

  const rows = useMemo(
    () => buildRows(snapshot.occurrences, snapshot.tasks),
    [snapshot.occurrences, snapshot.tasks]
  )
  const done = snapshot.occurrences.filter(o => o.status === 'done').length
  const total = snapshot.occurrences.length
  const hudBg = composeHudBg(snapshot.background, snapshot.opacity, themeBg)

  return {
    ready: snapshot.ready,
    mode: snapshot.mode,
    done,
    total,
    points: snapshot.points,
    rows,
    rowError,
    hudBg,
    background: snapshot.background ?? themeBg,
    opacity: snapshot.opacity,
    actions: { setMode, completeRow, addTask, setBackground, setOpacity, close }
  }
}
