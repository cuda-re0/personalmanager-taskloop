import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import { emitFocusTask } from '../tasks/focusTask'
import { RANGE_LABEL, canUndoEntry, formatSigned, timeLabel } from './pointsModel'
import { usePointsData } from './usePointsData'
import './points.css'

/**
 * 右栏 ③「积分」+ ④「明细」（04 §4③④）。
 *
 * 文字只有三类：字段值（余额、时:分、原因/标题、±N）、本文件登记的固定标签
 * （`今日` / `本周` / `本月`、行尾的 `撤销`）、以及 §4③ 写明的 `今日 +N` / `本周 +N` 两行。
 * 不写说明、不写图例、不写空状态文案（§7：明细无流水时留白）。
 *
 * v0.24：tabs 行最右端多一个 `›`，点开整窗明细页（`LedgerPage`）。它是图标不是文案；
 * ④ 原有的 tab、列表、行尾 `[撤销]`、已冲销态、就地提示全部保留。
 */

const RANGES = ['today', 'week', 'month'] as const

export interface PointsPanelProps {
  /** 打开整窗明细页（视图切换由 index.tsx 持有，这里只上报意图） */
  onOpenLedger(): void
}

export function PointsPanel({ onOpenLedger }: PointsPanelProps): ReactElement {
  const { balance, todayPoints, weekPoints, bars, entries, range, notice, setRange, undo } =
    usePointsData()

  return (
    <div className="points-panel">
      <section className="points-summary">
        <div className="points-head">
          <span className="points-total">{fmtPoints(balance)}</span>
          <div className="points-deltas">
            <span className="points-delta-line">{`${RANGE_LABEL.today} ${formatSigned(todayPoints)}`}</span>
            <span className="points-delta-line">{`${RANGE_LABEL.week} ${formatSigned(weekPoints)}`}</span>
          </div>
        </div>
        <div aria-hidden className="points-bars">
          {bars.map(bar => (
            <span
              className="points-bar"
              key={bar.day}
              style={{ height: `${bar.ratio * 100}%` }}
            />
          ))}
        </div>
      </section>

      <section className="points-ledger">
        <div className="points-tabs">
          {RANGES.map(item => (
            <button
              aria-pressed={item === range}
              className={item === range ? 'points-tab points-tab--on' : 'points-tab'}
              key={item}
              onClick={() => setRange(item)}
              type="button"
            >
              {RANGE_LABEL[item]}
            </button>
          ))}
          <button aria-label="明细" className="points-open" onClick={onOpenLedger} type="button">
            ›
          </button>
        </div>
        <ul className="ledger-list">
          {entries.map(entry => (
            <li key={entry.id}>
              <div
                className={
                  entry.reversedAt === null ? 'ledger-row' : 'ledger-row ledger-row--reversed'
                }
              >
                <button
                  className="ledger-main"
                  onClick={() => {
                    // 04 §4④：有 taskId 时跳到右栏 ① 对应任务（没有就什么都不做）
                    if (entry.taskId !== null) emitFocusTask(entry.taskId)
                  }}
                  type="button"
                >
                  <span className="ledger-time">{timeLabel(entry.createdAt)}</span>
                  <span className="ledger-text">{entry.reasonText}</span>
                  <span
                    className={entry.delta < 0 ? 'ledger-delta ledger-delta--neg' : 'ledger-delta'}
                  >
                    {formatSigned(entry.delta)}
                  </span>
                </button>
                {canUndoEntry(entry) ? (
                  <button className="ledger-undo" onClick={() => undo(entry)} type="button">
                    撤销
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {notice === null ? null : <div className="points-notice">{notice}</div>}
      </section>
    </div>
  )
}
