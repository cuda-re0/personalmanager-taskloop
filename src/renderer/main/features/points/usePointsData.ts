import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayStat, PointEntry } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import type { LedgerRange, PointsBar } from './pointsModel'
import { barsOf, localDayOf, rangeOf, sumPoints, weekStartOf } from './pointsModel'

/**
 * 右栏 ③④ 的数据入口。
 *
 * 只调已接通的读通道（`points.balance` / `points.monthStats` / `points.ledger`），
 * 服务端没给的东西一律不在这里算（红线 8）：今日/本周是**日聚合值求和**，不是重算流水；
 * 余额与柱子都来自返回值。
 *
 * 刷新：`points.changed` / `daystats.changed` 都会重拉——完成或手动调整之后
 * 余额、今日、柱状、明细四处要一起变。
 *
 * 本 hook 只服务 ③④ 的**平铺流水**（今日/本周/本月三档）。明细视图的数据在
 * `useLedgerView`，它随 `LedgerView` 一起挂载/卸载，于是"没点 `明细` 就不发请求"由挂载时机保证。
 */

/** 平铺流水一次最多取多少条（04 §4④ 只要求"最近流水"，不做分页） */
const LEDGER_LIMIT = 200

export interface PointsData {
  balance: number
  today: string
  todayPoints: number
  weekPoints: number
  bars: PointsBar[]
  entries: PointEntry[]
  range: LedgerRange
  setRange(range: LedgerRange): void
}

export function usePointsData(): PointsData {
  const [balance, setBalance] = useState(0)
  const [today, setToday] = useState(() => localDayOf(new Date()))
  const [stats, setStats] = useState<DayStat[]>([])
  const [entries, setEntries] = useState<PointEntry[]>([])
  const [range, setRange] = useState<LedgerRange>('today')

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
    void window.api.points
      .ledger({ from, to, limit: LEDGER_LIMIT })
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

  const todayPoints = useMemo(() => stats.find(s => s.day === today)?.points ?? 0, [stats, today])
  const weekPoints = useMemo(() => sumPoints(stats, weekStartOf(today), today), [stats, today])
  const bars = useMemo(() => barsOf(stats, today), [stats, today])

  return { balance, today, todayPoints, weekPoints, bars, entries, range, setRange }
}
