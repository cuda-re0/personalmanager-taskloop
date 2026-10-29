import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayStat, PointEntry } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'
import { toLocalDay } from '@shared/localDay'
import { monthStartOf } from './pointsModel'
import type { LedgerDayGroup } from './ledgerModel'
import {
  canGoNextMonth,
  groupEntriesByDay,
  monthNetOf,
  monthRangeOf,
  stepMonthOf
} from './ledgerModel'

/**
 * 明细页的数据入口（04 §4④ v0.24）。
 *
 * 只调两条已接通的读通道，不新增 IPC：`points.ledger` 取当月流水、
 * `points.monthStats` 取当月日聚合（净额从后者求和，见 `monthNetOf` 的注释）。
 *
 * 月份状态放在这里而不是组件里：`shiftMonth` 的「不许翻到未来月」要拿今天的月份比，
 * 而组件里不许做日期算术（硬性口径 3）。组件只调 `shiftMonth(±1)` 和读 `canGoNext`。
 *
 * 失败策略：`console.error` 就地记，列表保持空——本页只读，重进即可，不弹提示不写红字。
 */

/** 一个月最多取多少条流水（04 §4④ 定的 500；超出时列表截断、净额不受影响） */
const LEDGER_LIMIT = 500

export interface LedgerPageData {
  /** 当前查看的月份，值为当月 1 号 `YYYY-MM-01` */
  month: string
  /** 当月净额（来自 `DayStat` 求和，不是流水求和） */
  net: number
  /** 已按 day 降序分好组的流水 */
  groups: LedgerDayGroup[]
  /** `›` 是否可点：当前月为 false */
  canGoNext: boolean
  shiftMonth(delta: number): void
}

export function useLedgerPage(): LedgerPageData {
  const [today, setToday] = useState(() => toLocalDay(new Date()))
  const [month, setMonth] = useState(() => monthStartOf(today))
  const [entries, setEntries] = useState<PointEntry[]>([])
  const [stats, setStats] = useState<DayStat[]>([])
  /** 快速翻月时的竞态护栏：只认最后一次请求的返回 */
  const seq = useRef(0)

  const reload = useCallback((target: string): void => {
    seq.current += 1
    const mine = seq.current
    setToday(toLocalDay(new Date()))

    const { from, to } = monthRangeOf(target)
    const [year, mon] = target.split('-').map(Number)
    void Promise.all([
      window.api.points.ledger({ from, to, limit: LEDGER_LIMIT }),
      window.api.points.monthStats({ year, month: mon })
    ])
      .then(([ledgerRes, statsRes]) => {
        if (mine !== seq.current) return
        if (!ledgerRes.ok || !statsRes.ok) {
          console.error('[ledger] 读取失败', ledgerRes, statsRes)
          setEntries([])
          setStats([])
          return
        }
        setEntries(ledgerRes.data)
        setStats(statsRes.data)
      })
      .catch((e: unknown) => {
        console.error('[ledger] 读取失败', e)
        if (mine !== seq.current) return
        setEntries([])
        setStats([])
      })
  }, [])

  useEffect(() => {
    reload(month)
  }, [reload, month])

  // 完成/撤销/手动调整之后，本页若正开着也要跟着变（与右栏 ④ 同一条事件路径）
  useEffect(() => {
    const off = window.api.onEvent((e: DomainEvent) => {
      if (e.type === 'points.changed' || e.type === 'daystats.changed') reload(month)
    })
    return off
  }, [reload, month])

  const shiftMonth = useCallback((delta: number): void => {
    setMonth(current => stepMonthOf(current, delta, toLocalDay(new Date())))
  }, [])

  const groups = useMemo(() => groupEntriesByDay(entries), [entries])
  const net = useMemo(() => monthNetOf(stats), [stats])
  const canGoNext = useMemo(() => canGoNextMonth(month, today), [month, today])

  return { month, net, groups, canGoNext, shiftMonth }
}
