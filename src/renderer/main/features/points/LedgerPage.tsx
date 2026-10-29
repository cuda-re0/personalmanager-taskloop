import type { ReactElement } from 'react'
import { dayLabelOf, monthLabelOf, netLabel } from './ledgerModel'
import { formatSigned, timeLabel } from './pointsModel'
import { useLedgerPage } from './useLedgerPage'
import './points.css'

/**
 * 整窗明细页（04 §4④ v0.24）：按月翻、按日分组、每行「时刻 + 标题 + ±N」。
 *
 * 可见文字只有：`←` `‹` `›`、`2026年10月`、`10月28日`、`HH:mm`、`±N`、`reasonText`
 * 与页头/组头的净额。不写「今天」「昨天」，不写空状态文案（§7 空月只留白）。
 *
 * 本页**不提供撤销**：撤销入口只有右栏 ④ 一处，双入口迟早不一致（04 §4④ v0.24）。
 * 日期算术全在 `ledgerModel` / `useLedgerPage`，本文件里没有任何取日期、取月份、改日期的调用。
 */

export interface LedgerPageProps {
  /** `←`：回到工作台视图 */
  onBack(): void
  /** 点有 `taskId` 的行：切回工作台并高亮该任务（两件事由调用方在同一次交互里做） */
  onOpenTask(taskId: string): void
}

export function LedgerPage({ onBack, onOpenTask }: LedgerPageProps): ReactElement {
  const { month, net, groups, canGoNext, shiftMonth } = useLedgerPage()

  return (
    <div className="ledger-page">
      <header className="ledger-page-head">
        <button aria-label="返回" className="ledger-page-back" onClick={onBack} type="button">
          ←
        </button>
        <div className="ledger-page-months">
          <button
            aria-label="上个月"
            className="ledger-page-step"
            onClick={() => shiftMonth(-1)}
            type="button"
          >
            ‹
          </button>
          <span className="ledger-page-month">{monthLabelOf(month)}</span>
          <button
            aria-label="下个月"
            className="ledger-page-step"
            disabled={!canGoNext}
            onClick={() => shiftMonth(1)}
            type="button"
          >
            ›
          </button>
        </div>
        <span className={net < 0 ? 'ledger-page-net ledger-page-net--neg' : 'ledger-page-net'}>
          {netLabel(net)}
        </span>
      </header>

      <div className="ledger-page-body">
        {groups.map(group => (
          <section className="ledger-group" key={group.day}>
            <div className="ledger-group-head">
              <span className="ledger-group-day">{dayLabelOf(group.day)}</span>
              <span
                className={
                  group.net < 0 ? 'ledger-group-net ledger-group-net--neg' : 'ledger-group-net'
                }
              >
                {netLabel(group.net)}
              </span>
            </div>
            <ul className="ledger-group-list">
              {group.entries.map(entry => (
                <li key={entry.id}>
                  <button
                    className={
                      entry.reversedAt === null
                        ? 'ledger-page-row'
                        : 'ledger-page-row ledger-page-row--reversed'
                    }
                    onClick={() => {
                      if (entry.taskId !== null) onOpenTask(entry.taskId)
                    }}
                    type="button"
                  >
                    <span className="ledger-time">{timeLabel(entry.createdAt)}</span>
                    <span className="ledger-text">{entry.reasonText}</span>
                    <span
                      className={
                        entry.delta < 0 ? 'ledger-delta ledger-delta--neg' : 'ledger-delta'
                      }
                    >
                      {formatSigned(entry.delta)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
