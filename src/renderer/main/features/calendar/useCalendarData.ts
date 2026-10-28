import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayIndexEntry, DayTaskItem } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import { indexByDay, monthKey, shiftMonth, sortDayDetail } from './calendarModel'

/**
 * 右栏②「日历」的数据入口（04 §4② / 02 §3.2c）。
 *
 * 两条通道、两种时机：
 * - 切月 → `calendar.dayIndex({ year, month })` **一次**，整月红点一次拿全；
 * - 点日期 → `calendar.dayDetail({ day })`，只查那一天。
 *
 * 不做的事（红线）：不按天循环调 `dayIndex`、不缓存预热、不调 `ensureRange` / `occurrence.*`。
 * 红点口径（哪些类型进索引）由主进程 SQL 保证（01 §4.1），这里不重算。
 *
 * 切月去重：effect 依赖只有 `monthKey` 与刷新序号，另用一个 ref 记住「已经发出过的 token」。
 * React 18 StrictMode 会把 effect 跑两遍，第二遍命中同一个 token 直接返回，不会多发请求。
 * token 里带月份 key，所以切走再切回来仍是一次请求——但同一月份停在原地重渲染不会重发。
 *
 * 刷新：`task.created/updated/removed` 会让红点（实心/空心）或浮层内容过期，故按事件重拉
 * 当前月的索引与已展开那天的详情。同类事件在 200ms 内合并为一次刷新（完成一个任务会连发
 * task.updated，不合并就是每事件一次查询）。日历不关心 occurrence / message / points 事件。
 */

/** 事件合并窗口。只把同一批写操作并成一次查询，不参与任何展示逻辑 */
const REFRESH_COALESCE_MS = 200

export interface CalendarActions {
  /** 上一个月 */
  prevMonth(): void
  /** 下一个月 */
  nextMonth(): void
  /** 点日期：同日再点收起。任意日期都可点（04 §4② v0.21），空日期展开后列表留白 */
  selectDay(day: string): void
  /** 收起浮层（点外部 / 关闭按钮） */
  close(): void
  /** 点浮层行：派发集成交接事件并收起浮层（v0.16 第 4 条） */
  focusTask(taskId: string): void
}

export interface CalendarData {
  year: number
  month: number
  /** `YYYY-MM-DD` → 该日红点索引；每格 O(1) 查，不按月全表扫 */
  index: Map<string, DayIndexEntry>
  selectedDay: string | null
  /** 已展开那天的条目（只含 deadline / event），按时间升序 */
  detail: DayTaskItem[]
  actions: CalendarActions
}

export function useCalendarData(): CalendarData {
  const [view, setView] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  })
  const [index, setIndex] = useState<Map<string, DayIndexEntry>>(() => new Map())
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<{ day: string; items: DayTaskItem[] } | null>(null)
  /** 写操作触发的刷新序号；进 effect 依赖，使 token 变化 */
  const [rev, setRev] = useState(0)

  /** 已发出请求的 token（月份 key 或日期 + 刷新序号） */
  const indexIssuedRef = useRef('')
  const detailIssuedRef = useRef('')
  /** 「当前有效」token：响应回来时比对，丢弃过期月份的响应 */
  const indexLatestRef = useRef('')
  const detailLatestRef = useRef('')

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
    if (!selectedDay) {
      detailLatestRef.current = ''
      return
    }
    const token = `${selectedDay}#${rev}`
    detailLatestRef.current = token
    if (detailIssuedRef.current === token) return
    detailIssuedRef.current = token
    void window.api.calendar
      .dayDetail({ day: selectedDay })
      .then(res => {
        if (detailLatestRef.current !== token) return
        if (!res.ok) {
          console.error('[calendar] calendar.dayDetail 失败', res.error)
          setDetailState({ day: selectedDay, items: [] })
          return
        }
        setDetailState({ day: selectedDay, items: sortDayDetail(res.data) })
      })
      .catch((e: unknown) => console.error('[calendar] calendar.dayDetail 调用失败', e))
  }, [selectedDay, rev])

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
    setSelectedDay(null)
    setView(v => shiftMonth(v.year, v.month, -1))
  }, [])

  const nextMonth = useCallback((): void => {
    setSelectedDay(null)
    setView(v => shiftMonth(v.year, v.month, 1))
  }, [])

  const selectDay = useCallback((day: string): void => {
    setSelectedDay(prev => (prev === day ? null : day))
  }, [])

  const close = useCallback((): void => {
    setSelectedDay(null)
  }, [])

  const focusTask = useCallback((taskId: string): void => {
    // 集成交接点（v0.16 第 4 条）：接收方是右栏任务面板，本线不持有它
    window.dispatchEvent(new CustomEvent('taskloop:focus-task', { detail: { id: taskId } }))
    setSelectedDay(null)
  }, [])

  const actions = useMemo<CalendarActions>(
    () => ({ prevMonth, nextMonth, selectDay, close, focusTask }),
    [prevMonth, nextMonth, selectDay, close, focusTask]
  )

  /** 只认「当前选中那天」的详情，切日/切月时不会闪出上一天的列表 */
  const detail = useMemo<DayTaskItem[]>(
    () => (selectedDay && detailState?.day === selectedDay ? detailState.items : []),
    [selectedDay, detailState]
  )

  return { year: view.year, month: view.month, index, selectedDay, detail, actions }
}
