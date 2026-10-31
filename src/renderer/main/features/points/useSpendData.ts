import { useCallback, useEffect, useState } from 'react'
import type { PointEntry } from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'

/**
 * 支出页的数据与动作（v0.45，45 §7.2）。
 *
 * 只有三条通道会用到：`points.spendMonth`（读）、`points.spend`、`points.spendUndo`（写）。
 * 写完不乐观更新——重新拉一次 `spendMonth`，账面上的数字只信服务端。
 *
 * 刷新时机：`points.changed`（自己记的一笔、别处撤销）与 `fx.changed`（周一的评估在后台
 * 落库，开着的支出页要自己换汇率）都重拉；别的域事件一律忽略。
 */
export interface SpendData {
  entries: PointEntry[]
  totalCents: number
  rate: number
  submitting: boolean
  /** 正在撤销的那一行；只有它自己 disabled */
  undoingId: string | null
  /** 后端 `message` 原文，渲染在输入行上方 */
  error: string | null
  /** 记账；返回是否成功（成功才清输入框） */
  submit(amountCents: number, note: string): Promise<boolean>
  undo(entryId: string): Promise<void>
}

export function useSpendData(): SpendData {
  const [entries, setEntries] = useState<PointEntry[]>([])
  const [totalCents, setTotalCents] = useState(0)
  const [rate, setRate] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.api.points
      .spendMonth()
      .then(res => {
        if (!res.ok) {
          setError(res.error.message)
          return
        }
        setEntries(res.data.entries)
        setTotalCents(res.data.totalCents)
        setRate(res.data.rate)
      })
      .catch((e: unknown) => {
        console.error('[spend] 本月支出加载失败', e)
      })
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    const off = window.api.onEvent((e: DomainEvent) => {
      if (e.type === 'points.changed' || e.type === 'fx.changed') reload()
    })
    return off
  }, [reload])

  const submit = useCallback(
    async (amountCents: number, note: string): Promise<boolean> => {
      setSubmitting(true)
      setError(null)
      try {
        const trimmed = note.trim()
        const res = await window.api.points.spend(
          trimmed === '' ? { amountCents } : { amountCents, note: trimmed }
        )
        if (!res.ok) {
          setError(res.error.message)
          return false
        }
        reload()
        return true
      } catch (e: unknown) {
        console.error('[spend] 记账失败', e)
        return false
      } finally {
        setSubmitting(false)
      }
    },
    [reload]
  )

  const undo = useCallback(
    async (entryId: string): Promise<void> => {
      setUndoingId(entryId)
      setError(null)
      try {
        const res = await window.api.points.spendUndo({ entryId })
        if (!res.ok) {
          setError(res.error.message)
          return
        }
        // 不本地删行：重拉之后"这一笔真的不在了"才算数
        reload()
      } catch (e: unknown) {
        console.error('[spend] 撤销失败', e)
      } finally {
        setUndoingId(null)
      }
    },
    [reload]
  )

  return { entries, totalCents, rate, submitting, undoingId, error, submit, undo }
}
