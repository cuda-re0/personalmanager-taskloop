import { useState, type ReactElement } from 'react'
import { fmtMoney } from '@shared/format'
import {
  isOverBudget,
  parseAmountToCents,
  spendHeaderParts,
  spendTimeLabel,
  spendToday
} from './spendModel'
import { useSpendData } from './useSpendData'

/**
 * ④ 的第五个视图「支出」（v0.45，45 §7.2）。
 *
 * 只替换标签行以下的内容区（标签行留在 `PointsPanel` 里，否则回不到其它视图）。
 * 文字只有三类：字段值（时间、备注、`-12.5 元`）、顶部那行模板、以及 `元` / `记一笔` / `撤销`
 * 三个固定字。**没有**输入提示语、空态文案、加载中文案、确认弹窗、分类、emoji、tooltip。
 *
 * 行不是按钮：行里有 `[撤销]`，button 不能嵌套 button，做成整行按钮会产出无效 DOM。
 */
export function SpendView(): ReactElement {
  const { entries, totalCents, rate, submitting, undoingId, error, submit, undo } = useSpendData()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const today = spendToday()
  const month = Number(today.slice(5, 7))
  const cents = parseAmountToCents(amount)
  const parts = spendHeaderParts(month, rate, totalCents)
  const over = isOverBudget(totalCents)

  const handleSubmit = async (): Promise<void> => {
    if (cents === null) return
    const ok = await submit(cents, note)
    // 成功才清空：失败了用户要能改一个字符重试，不能让他重打一遍
    if (ok) {
      setAmount('')
      setNote('')
    }
  }

  return (
    <div className="spend-view">
      <div className="spend-head">
        <span>{parts.prefix}</span>
        <span
          className={over ? 'spend-head-spent spend-head-spent--over' : 'spend-head-spent'}
        >
          {parts.spent}
        </span>
      </div>

      <ul className="spend-list">
        {entries.map(entry => (
          <li className="spend-row" key={entry.id}>
            <span className="spend-time">{spendTimeLabel(entry.createdAt, today)}</span>
            {entry.reasonText !== '' && <span className="spend-note">{entry.reasonText}</span>}
            <span className="spend-amount">{`-${fmtMoney(entry.amountCents ?? 0)} 元`}</span>
            <button
              className="spend-undo"
              disabled={undoingId === entry.id}
              onClick={() => void undo(entry.id)}
              type="button"
            >
              撤销
            </button>
          </li>
        ))}
      </ul>

      {error !== null && <div className="spend-error">{error}</div>}

      <div className="spend-form">
        <input
          className="spend-amount-input"
          inputMode="decimal"
          maxLength={7}
          onChange={e => setAmount(e.target.value)}
          value={amount}
        />
        <span className="spend-unit">元</span>
        <input
          aria-label="备注"
          className="spend-note-input"
          maxLength={40}
          onChange={e => setNote(e.target.value)}
          value={note}
        />
        <button
          className="spend-submit"
          disabled={cents === null || submitting}
          onClick={() => void handleSubmit()}
          type="button"
        >
          记一笔
        </button>
      </div>
    </div>
  )
}
