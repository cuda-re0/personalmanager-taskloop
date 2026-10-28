import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import { emitFocusTask } from '../tasks/focusTask'
import { RANGE_LABEL, formatSigned, timeLabel } from './pointsModel'
import { usePointsData } from './usePointsData'
import './points.css'

/**
 * 右栏 ③「积分」+ ④「明细」（04 §4③④）。
 *
 * 文字只有三类：字段值（余额、时:分、原因/标题、±N）、本文件登记的固定标签
 * （`今日` / `本周` / `本月`）、以及 §4③ 写明的 `今日 +N` / `本周 +N` 两行。
 * 不写说明、不写图例、不写空状态文案（§7：明细无流水时留白）。
 */

const RANGES = ['today', 'week', 'month'] as const

export function PointsPanel(): ReactElement {
  const { balance, todayPoints, weekPoints, bars, entries, range, setRange } = usePointsData()

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
        </div>
        <ul className="ledger-list">
          {entries.map(entry => (
            <li key={entry.id}>
              <button
                className="ledger-row"
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
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
