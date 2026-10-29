import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayIndexEntry, Occurrence } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import { indexByDay, monthKey, shiftMonth } from './calendarModel'

/**
 * 右栏②「日历」的数据入口（04 §4②）。
 *
 * 月视图一条通道：切月 → `calendar.dayIndex({ year, month })` **一次**，整月红点一次拿全。
 * 红点口径（哪些类型进索引）由主进程 SQL 保证（01 §4.1），这里不重算。
 *
 * 日历层（v0.28）的数据不在这里：`useDayOccurrences` 由 `CalendarDayView` 挂载时调用，
 * 没选日子就不挂载、不发请求（零请求原则）。
 *
 * 切月去重：effect 依赖只有 `monthKey` 与刷新序号，另用一个 ref 记住「已经发出过的 token」。
 * React 18 StrictMode 会把 effect 跑两遍，第二遍命中同一个 token 直接返回，不会多发请求。
 *
 * 刷新：`task.created/updated/removed` 会让红点（实心/空心）过期，按事件重拉当前月索引。
 * 同类事件在 200ms 内合并为一次刷新。日历层自己的刷新在 useDayOccurrences 里。
 */

/** 事件合并窗口。只把同一批写操作并成一次查询，不参与任何展示逻辑 */
const REFRESH_COALESCE_MS = 200

export interface CalendarActions {
  /** 上一个月 */
  prevMonth(): void
  /** 下一个月 */
  nextMonth(): void
}

export interface CalendarData {
  year: number
  month: number
  /** `YYYY-MM-DD` → 该日红点索引；每格 O(1) 查，不按月全表扫 */
  index: Map<string, DayIndexEntry>
  actions: CalendarActions
}

export function useCalendarData(): CalendarData {
  const [view, setView] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  })
  const [index, setIndex] = useState<Map<string, DayIndexEntry>>(() => new Map())
  /** 写操作触发的刷新序号；进 effect 依赖，使 token 变化 */
  const [rev, setRev] = useState(0)

  /** 已发出请求的 token（月份 key + 刷新序号） */
  const indexIssuedRef = useRef('')
  /** 「当前有效」token：响应回来时比对，丢弃过期月份的响应 */
  const indexLatestRef = useRef('')

  const key = monthKey(view.year, view.month)

  useEffect(() => {
    const token = `${key}#${rev}`
    indexLatestRef.current = token
    if (indexIssuedRef.current === token) return
    indexIssuedRef.current = token
    void window.api.calendar
      .dayIndex({ year: view.year, month: view.month })
      .then(res => {
        if (indexLatestRef.current !== token) return
        if (!res.ok) {
          console.error('[calendar] calendar.dayIndex 失败', res.error)
          setIndex(new Map())
          return
        }
        setIndex(indexByDay(res.data))
      })
      .catch((e: unknown) => console.error('[calendar] calendar.dayIndex 调用失败', e))
  }, [key, rev, view.year, view.month])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onEvent((e: DomainEvent) => {
      switch (e.type) {
        case 'task.created':
        case 'task.updated':
        case 'task.removed':
          if (timer !== null) return
          timer = setTimeout(() => {
            timer = null
            setRev(r => r + 1)
          }, REFRESH_COALESCE_MS)
          break
        default:
          break
      }
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      off()
    }
  }, [])

  const prevMonth = useCallback((): void => {
    setView(v => shiftMonth(v.year, v.month, -1))
  }, [])

  const nextMonth = useCallback((): void => {
    setView(v => shiftMonth(v.year, v.month, 1))
  }, [])

  const actions = useMemo<CalendarActions>(() => ({ prevMonth, nextMonth }), [prevMonth, nextMonth])

  return { year: view.year, month: view.month, index, actions }
}

/* ------------------------------------------------------------------ *
 * 日历层（04 §4② v0.28）：选中日当天的任务 + 完成情况
 * ------------------------------------------------------------------ */

/** 日历层的一行：勾状态 + 任务标题 */
export interface DayViewRow {
  occurrenceId: string
  taskId: string
  title: string
  done: boolean
}

/**
 * listByRange 结果 → 日历层行数据。勾状态映射：pending→空心、done→实心（04 §4② v0.28）。
 * missed/skipped 不显示（v0.27 同口径：用户只关心今天要做什么、做完了什么）。
 * 标题用联表带出的 taskTitle，单次请求拿全，不二次查询。
 */
export function dayViewRows(list: Occurrence[]): DayViewRow[] {
  return list
    .filter(o => o.status === 'pending' || o.status === 'done')
    .map(o => ({
      occurrenceId: o.id,
      taskId: o.taskId,
      title: o.taskTitle ?? '',
      done: o.status === 'done'
    }))
}

/**
 * 选中那一天的 occurrence 行（挂载 / 换日拉一次；打开期间打卡等事件触发刷新）。
 * 只在 CalendarDayView 挂载时使用——没选日子组件不存在，天然零请求。
 */
export function useDayOccurrences(day: string): DayViewRow[] {
  const [rows, setRows] = useState<DayViewRow[]>([])
  /** 事件触发的刷新序号：进 token 使已发请求过期 */
  const [rev, setRev] = useState(0)
  const issuedRef = useRef('')
  const latestRef = useRef('')

  useEffect(() => {
    const token = `${day}#${rev}`
    latestRef.current = token
    if (issuedRef.current === token) return
    issuedRef.current = token
    void window.api.occurrence
      .listByRange({ from: day, to: day })
      .then(res => {
        if (latestRef.current !== token) return
        if (!res.ok) {
          console.error('[calendar] occurrence.listByRange 失败', res.error)
          setRows([])
          return
        }
        setRows(dayViewRows(res.data))
      })
      .catch((e: unknown) => console.error('[calendar] occurrence.listByRange 调用失败', e))
  }, [day, rev])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onEvent((e: DomainEvent) => {
      switch (e.type) {
        case 'occurrence.created':
        case 'occurrence.updated':
        case 'task.created':
        case 'task.updated':
        case 'task.removed':
          if (timer !== null) return
          timer = setTimeout(() => {
            timer = null
            setRev(r => r + 1)
          }, REFRESH_COALESCE_MS)
          break
        default:
          break
      }
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      off()
    }
  }, [])

  return rows
}
