import type { ReactElement } from 'react'
import { dayLabelOf, monthLabelOf, netLabel } from './ledgerModel'
import { formatSigned, timeLabel } from './pointsModel'
import { useLedgerView } from './useLedgerView'
import './points.css'

/**
 * ④ 面板里的明细视图（04 §4④ v0.26）：月导航 + 按日分组的流水。
 *
 * 它**不是**整窗页面：没有页头、没有返回按钮、不覆盖任何东西，就是 ④ 里
 * tabs 行以下那一块内容，选中 `明细` 标签时就地替换平铺流水。③ 积分在它之外，始终在。
 *
 * 可见文字只有：`‹` `›`、`2026年10月`、`10月28日`、`HH:mm`、`±N`、`reasonText` 与当月净额。
 * 不写「今天」「昨天」，不写空状态文案（§7 空月只留白）。流水是只读的，行上只有三样东西。
 *
 * 日期算术全在 `ledgerModel` / `useLedgerView`，本文件里没有取日期、取月份、改日期的调用。
 */

export interface LedgerViewProps {
  /** 点有 `taskId` 的行：高亮右栏 ① 对应任务（不切视图、不滚动整页） */
  onOpenTask(taskId: string): void
}

export function LedgerView({ onOpenTask }: LedgerViewProps): ReactElement {
  const { month, net, groups, canGoNext, shiftMonth } = useLedgerView()

  return (
    <div className="ledger-view">
      <div className="ledger-nav">
        <button
          aria-label="上个月"
          className="ledger-step"
          onClick={() => shiftMonth(-1)}
          type="button"
        >
          ‹
        </button>
        <span className="ledger-nav-month">{monthLabelOf(month)}</span>
        <button
          aria-label="下个月"
          className="ledger-step"
          disabled={!canGoNext}
          onClick={() => shiftMonth(1)}
          type="button"
        >
          ›
        </button>
        <span className={net < 0 ? 'ledger-nav-net ledger-nav-net--neg' : 'ledger-nav-net'}>
          {netLabel(net)}
        </span>
      </div>

      <div className="ledger-body">
        {groups.map(group => (
          <section className="ledger-group" key={group.day}>
            <div className="ledger-group-head">
              <span>{dayLabelOf(group.day)}</span>
            </div>
            <ul className="ledger-group-list">
              {group.entries.map(entry => (
                <li key={entry.id}>
                  <button
                    className={
                      entry.reversedAt === null ? 'ledger-row' : 'ledger-row ledger-row--reversed'
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
