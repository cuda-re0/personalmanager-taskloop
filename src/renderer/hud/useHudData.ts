import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Occurrence, Task } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import type { HudMode } from '@shared/types/ipc'
import {
  buildRows,
  composeHudBg,
  localDayOf,
  withinHudWindow,
  type HudRow
} from './hudModel'

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
 *
 * v0.46：`showMain` 只是窗口动作，不读也不改这里的任何状态。
 */

const ACTIVE_STATUS = new Set(['todo', 'doing', 'reviewing', 'pending_review'])
/** 行内红字停留时长：`AppError.message` 原样展示，够看清即可（与主窗同口径） */
const ERROR_TTL_MS = 4000
/** 温度轮询间隔（v0.62）：LHM 自己约 1 秒刷一次，再密也只是问同一份采样 */
const SENSORS_POLL_MS = 2000
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
  /** v0.62：两路温度，`null` = 那一路拿不到（只由 `hud.sensors` 轮询覆盖） */
  sensors: { cpu: number | null; gpu: number | null }
}

const EMPTY: Snapshot = {
  ready: false,
  mode: 'ball',
  occurrences: [],
  tasks: [],
  points: 0,
  background: null,
  opacity: 1,
  sensors: { cpu: null, gpu: null }
}

/** 行内错误：哪一行 + `AppError.message` 原文 */
export interface HudRowError {
  rowId: string
  message: string
}

export interface HudActions {
  /** 手动切换形态：点球 → `panel`，ESC → `ball`（主进程换 bounds + 广播） */
  setMode(mode: HudMode): void
  /** 勾一行：只有每日打卡能勾（`occurrence.complete`）；限时/活动不提供完成，直接返回 */
  completeRow(row: HudRow): void
  /** 一句话加任务：`task.createManual`（deadline / medium / 无 due_at）。成功返回 true */
  addTask(title: string): Promise<boolean>
  /** 背景色（`#rrggbb`）：即时生效 + 落 `hud.background` */
  setBackground(color: string): void
  /** 透明度 0.3–1：即时生效 + 落 `hud.opacity` */
  setOpacity(value: number): void
  /** 叫出主窗（`app.showMain`，v0.46）：隐藏或最小化则显示聚焦，已关掉则重建 */
  showMain(): void
  /** 关闭悬浮窗（`hud.setVisible({ visible: false })`），回主窗顶栏可再打开 */
  close(): void
}

export interface HudData {
  ready: boolean
  mode: HudMode
  /** 列表里已结束（done / missed）的行数 / 列表总行数（04 §5.3 v0.39，与列表同源） */
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
  /** v0.62：长条上的 CPU / GPU 温度；拿不到的一路是 null（渲染成 `--`） */
  sensors: { cpu: number | null; gpu: number | null }
  actions: HudActions
}

/** 主题底色（`--bg`）：`hud.background` 为 null 时用它合成 rgba */
function readThemeBg(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_BG
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  return value.length > 0 ? value : DEFAULT_THEME_BG
}

function upsertOccurrences(
  list: Occurrence[],
  incoming: Occurrence[],
  titleOf: (taskId: string) => string | undefined
): Occurrence[] {
  // 只收今天（v0.21）：HUD 的 done/total 就是「今日打卡」，混进未来日期会把 0/1 显示成 0/4
  const today = localDayOf(new Date())
  const map = new Map(list.filter(o => o.day === today).map(o => [o.id, o] as const))
  for (const o of incoming) {
    if (o.day !== today) continue
    // `occurrence.complete/undo/skip` 与 `task.createManual` 推的是裸行（无联表字段），
    // `taskTitle` 会被覆盖成 undefined → HUD 列表会变成空白行。按「上一条同 id > 任务表」补齐，
    // 同 id 同任务，不会串。
    const prev = map.get(o.id)
    map.set(o.id, {
      ...o,
      taskTitle: o.taskTitle ?? prev?.taskTitle ?? titleOf(o.taskId),
      taskType: o.taskType ?? prev?.taskType
    })
  }
  return [...map.values()]
}

/**
 * 任务增量（04 §5.3 v0.38）：
 * - 活跃态（含 `pending_review`）正常 upsert；
 * - 未命中但**今天改过** → 保留并更新。完成态就靠这条留在列表里"变灰沉底"；
 * - 未命中且跨日 → 移除。
 */
function upsertTask(list: Task[], task: Task): Task[] {
  const index = list.findIndex(t => t.id === task.id)
  const today = localDayOf(new Date())
  const keep = ACTIVE_STATUS.has(task.status) || localDayOf(new Date(task.updatedAt)) === today
  if (!keep) {
    return index >= 0 ? list.filter(t => t.id !== task.id) : list
  }
  if (index < 0) return [...list, task]
  const next = [...list]
  next[index] = task
  return next
}

/**
 * 首载补拉今天已完成/错过（v0.38）：`bootstrap.tasks` 只给活跃三态，
 * 不补这一次，"完成变灰沉底"只在本次会话内成立，重启后那些行就没了。
 * 只收 `updatedAt` 落在今天的，跨日的历史完成不进 HUD。
 */
function mergeTodayFinished(active: Task[], finished: Task[]): Task[] {
  const today = localDayOf(new Date())
  const map = new Map(active.map(t => [t.id, t] as const))
  for (const task of finished) {
    if (localDayOf(new Date(task.updatedAt)) !== today) continue
    if (!map.has(task.id)) map.set(task.id, task)
  }
  return [...map.values()]
}

export function useHudData(): HudData {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [rowError, setRowError] = useState<HudRowError | null>(null)
  /**
   * 悬浮窗的「今天」（86b）：必须是状态，不能每次渲染现算。
   * 窗口会挂着过夜，没有触发点的现算值只会停在零点之前那一天；
   * 下面那个 effect 负责跨零点重算。
   */
  const [today, setToday] = useState(() => localDayOf(new Date()))
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** v0.62：温度通道挂了只提示一次，不在界面上显示任何错误 */
  const sensorsWarned = useRef(false)
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
        // occurrence 的裸行没有标题，按 taskId 从任务表补（任务行先到，见 02 §3.8 的广播顺序）
        const titleOf = (taskId: string): string | undefined =>
          prev.tasks.find(t => t.id === taskId)?.title
        switch (event.type) {
          case 'occurrence.created':
            return {
              ...prev,
              occurrences: upsertOccurrences(prev.occurrences, event.occurrences, titleOf)
            }
          case 'occurrence.updated':
            return {
              ...prev,
              occurrences: upsertOccurrences(prev.occurrences, [event.occurrence], titleOf)
            }
          case 'task.created':
          case 'task.updated':
            return { ...prev, tasks: upsertTask(prev.tasks, event.task) }
          case 'task.removed':
            // daily 的行只由 occurrences 建行（buildRows 里 tasks 排除了 daily），
            // 只清 tasks 会让整行继续挂在悬浮窗上（v0.85c）
            return {
              ...prev,
              tasks: prev.tasks.filter(t => t.id !== event.taskId),
              occurrences: prev.occurrences.filter(o => o.taskId !== event.taskId)
            }
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

    // 第三路是 v0.38 的首载补拉：今天的 `done` / `missed` 任务（bootstrap 只给活跃态）。
    // 失败只记控制台，不拦住 HUD——活跃任务照样显示，只是少了今天的完成行。
    void Promise.all([
      window.api.hud.getState(),
      window.api.app.getBootstrap(),
      window.api.task.list({ status: ['done', 'missed'] })
    ])
      .then(([state, bootstrap, finished]) => {
        if (!alive) return
        if (!state.ok) {
          console.error('[hud] hud.getState 失败', state.error)
          return
        }
        if (!bootstrap.ok) {
          console.error('[hud] app.getBootstrap 失败', bootstrap.error)
          return
        }
        if (!finished.ok) console.error('[hud] task.list 补拉失败', finished.error)
        const { tasks, todayOccurrences, today, settings } = bootstrap.data
        setSnapshot({
          ready: true,
          // 形态以窗口状态为准（settings 里的是上次落库值，可能还没同步到窗口）
          mode: state.data.mode,
          occurrences: todayOccurrences,
          tasks: mergeTodayFinished(tasks, finished.ok ? finished.data : []),
          points: today.points,
          background: settings['hud.background'],
          opacity: settings['hud.opacity'],
          sensors: EMPTY.sensors
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
   * 跨零点重算「今天」（86b）：排到下一个本地零点 +2 秒触发，然后递归排下一次。
   * 另外监听窗口焦点——机器休眠跨零点、后台定时器被节流时，靠这次补算兜住。
   */
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = (): void => {
      const now = new Date()
      // 本地日历加一天再取当天 00:00:02，月份/年份进位由 Date 自己处理
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2)
      timer = setTimeout(
        () => {
          if (!alive) return
          setToday(localDayOf(new Date()))
          schedule()
        },
        Math.max(1000, next.getTime() - now.getTime())
      )
    }

    const onFocus = (): void => setToday(localDayOf(new Date()))

    schedule()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  /**
   * 温度轮询（v0.62）：只在长条态拉——面板态不显示温度，白拉一次 HTTP。
   * 每次只覆盖 `sensors`，失败置两个 null（界面显示 `--`），不碰其它字段。
   */
  useEffect(() => {
    if (snapshot.mode !== 'ball') return

    let alive = true
    const pull = (): void => {
      void window.api.hud
        .sensors()
        .then(res => {
          if (!alive) return
          if (!res.ok) {
            if (!sensorsWarned.current) {
              sensorsWarned.current = true
              console.warn('[hud] hud.sensors 失败', res.error)
            }
            setSnapshot(prev => ({ ...prev, sensors: { cpu: null, gpu: null } }))
            return
          }
          setSnapshot(prev => ({
            ...prev,
            sensors: { cpu: res.data.cpu, gpu: res.data.gpu }
          }))
        })
        .catch((e: unknown) => {
          if (!alive) return
          if (!sensorsWarned.current) {
            sensorsWarned.current = true
            console.warn('[hud] hud.sensors 调用失败', e)
          }
          setSnapshot(prev => ({ ...prev, sensors: { cpu: null, gpu: null } }))
        })
    }

    pull()
    const timer = setInterval(pull, SENSORS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [snapshot.mode])

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
      // 限时/活动只起提醒作用：HUD 不给完成入口，也就不替用户绕过审核发分（v0.38）
      if (!row.completable) return
      if (row.done) return
      void window.api.occurrence
        .complete({ id: row.id })
        .then(res => {
          if (!res.ok) showError(row.id, res.error.message)
        })
        .catch((e: unknown) => console.error('[hud] occurrence.complete 调用失败', e))
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

  const showMain = useCallback((): void => {
    void window.api.app
      .showMain()
      .then(res => {
        if (!res.ok) console.error('[hud] app.showMain 失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] app.showMain 调用失败', e))
  }, [])

  const close = useCallback((): void => {
    void window.api.hud
      .setVisible({ visible: false })
      .then(res => {
        if (!res.ok) console.error('[hud] hud.setVisible 失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] hud.setVisible 调用失败', e))
  }, [])

  // 过滤只在装配层做一次；增量（handleEvent）与首载补拉（mergeTodayFinished）都不改
  const rows = useMemo(
    () => buildRows(snapshot.occurrences, withinHudWindow(snapshot.tasks, today)),
    [snapshot.occurrences, snapshot.tasks, today]
  )
  // N/M 与列表同源（04 §5.3 v0.39）：分母是列表行数（含限时/活动），分子是已结束（done / missed）行数。
  // 不再单独数 occurrences——两套数各算各的必然对不上。
  const done = rows.filter(row => row.done).length
  const total = rows.length
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
    sensors: snapshot.sensors,
    actions: { setMode, completeRow, addTask, setBackground, setOpacity, showMain, close }
  }
}
