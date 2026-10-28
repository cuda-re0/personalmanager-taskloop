import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayStat, PointEntry } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import type { LedgerRange, PointsBar } from './pointsModel'
import { barsOf, localDayOf, rangeOf, sumPoints, weekStartOf } from './pointsModel'

/**
 * 右栏 ③④ 的数据入口。
 *
 * 只调已接通的通道（`points.balance` / `points.monthStats` / `points.ledger` / `task.undo`），
 * 服务端没给的东西一律不在这里算（红线 8）：今日/本周是**日聚合值求和**，不是重算流水；
 * 余额与柱子都来自返回值。
 *
 * 刷新：`points.changed` / `daystats.changed` 都会重拉——完成、撤销、手动调整之后
 * 余额、今日、柱状、明细四处要一起变。`task.undo` 成功后**不另起刷新路径**：
 * 主进程的 handler 已经广播这两条事件，重拉由订阅完成（04 §4④）。
 */

/** 明细一次最多取多少条（04 §4④ 只要求"最近流水"，不做分页） */
const LEDGER_LIMIT = 200

/** 就地提示停留时长（撤销超窗这类错误） */
const NOTICE_TTL_MS = 2600

export interface PointsData {
  balance: number
  today: string
  todayPoints: number
  weekPoints: number
  bars: PointsBar[]
  entries: PointEntry[]
  range: LedgerRange
  /** 主进程返回的错误短句（超 24h 撤销等），非 null 时就地显示，到点自动消失 */
  notice: string | null
  setRange(range: LedgerRange): void
  /** ④ 行尾的 `[撤销]` → task.undo（调用方先用 canUndoEntry 过一遍三条件） */
  undo(entry: PointEntry): void
}

export function usePointsData(): PointsData {
  const [balance, setBalance] = useState(0)
  const [today, setToday] = useState(() => localDayOf(new Date()))
  const [stats, setStats] = useState<DayStat[]>([])
  const [entries, setEntries] = useState<PointEntry[]>([])
  const [range, setRange] = useState<LedgerRange>('today')
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNotice = useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_TTL_MS)
  }, [])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )

  const reloadSummary = useCallback(() => {
    const day = localDayOf(new Date())
    setToday(day)
    const [year, month] = day.split('-').map(Number)
    // 7 日窗口与"本周"都可能跨月，把上个月的日聚合一起取回来（每月一次调用，不是每天）
    const prevYear = month === 1 ? year - 1 : year
    const prevMonth = month === 1 ? 12 : month - 1
    void Promise.all([
      window.api.points.balance(),
      window.api.points.monthStats({ year, month }),
      window.api.points.monthStats({ year: prevYear, month: prevMonth })
    ])
      .then(([balanceRes, currentRes, previousRes]) => {
        if (!balanceRes.ok) {
          console.error('[points] balance 失败', balanceRes.error)
          return
        }
        if (!currentRes.ok || !previousRes.ok) {
          console.error('[points] monthStats 失败', currentRes, previousRes)
          return
        }
        setBalance(balanceRes.data)
        setStats([...previousRes.data, ...currentRes.data])
      })
      .catch((e: unknown) => console.error('[points] 汇总加载失败', e))
  }, [])

  const reloadLedger = useCallback((target: LedgerRange) => {
    const { from, to } = rangeOf(target, localDayOf(new Date()))
    void window.api.points.ledger({ from, to, limit: LEDGER_LIMIT })
      .then(res => {
        if (!res.ok) {
          console.error('[points] ledger 失败', res.error)
          return
        }
        setEntries(res.data)
      })
      .catch((e: unknown) => console.error('[points] 明细加载失败', e))
  }, [])

  useEffect(() => {
    reloadSummary()
  }, [reloadSummary])

  useEffect(() => {
    reloadLedger(range)
  }, [reloadLedger, range])

  useEffect(() => {
    const off = window.api.onEvent((e: DomainEvent) => {
      if (e.type === 'points.changed' || e.type === 'daystats.changed') {
        reloadSummary()
        reloadLedger(range)
      }
    })
    return off
  }, [reloadSummary, reloadLedger, range])

  const todayPoints = useMemo(
    () => stats.find(s => s.day === today)?.points ?? 0,
    [stats, today]
  )
  const weekPoints = useMemo(
    () => sumPoints(stats, weekStartOf(today), today),
    [stats, today]
  )
  const bars = useMemo(() => barsOf(stats, today), [stats, today])

  /**
   * ④ 行尾 `[撤销]`（04 §4④）：调 `task.undo`，成功后的刷新走 `points.changed` /
   * `daystats.changed` 事件（与完成同一条路径），失败把主进程的中文短句就地显示。
   */
  const undo = useCallback(
    (entry: PointEntry): void => {
      if (entry.taskId === null) return
      void window.api.task
        .undo({ id: entry.taskId })
        .then(res => {
          if (!res.ok) showNotice(res.error.message)
        })
        .catch((e: unknown) => console.error('[points] task.undo 调用失败', e))
    },
    [showNotice]
  )

  return {
    balance,
    today,
    todayPoints,
    weekPoints,
    bars,
    entries,
    range,
    notice,
    setRange,
    undo
  }
}
