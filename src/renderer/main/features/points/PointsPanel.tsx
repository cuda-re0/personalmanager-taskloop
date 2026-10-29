import { useState, type ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import { emitFocusTask } from '../tasks/focusTask'
import type { LedgerRange } from './pointsModel'
import { LEDGER_VIEW_LABEL, RANGE_LABEL, formatSigned, timeLabel } from './pointsModel'
import { LedgerView } from './LedgerView'
import { usePointsData } from './usePointsData'
import './points.css'

/**
 * 右栏 ③「积分」+ ④「明细」（04 §4③④）。
 *
 * 文字只有三类：字段值（余额、时:分、原因/标题、±N）、本文件登记的固定标签
 * （`今日` / `本周` / `本月` / `明细`）、以及 §4③ 写明的 `今日 +N` / `本周 +N` 两行。
 * 不写说明、不写图例、不写空状态文案（§7：明细无流水时留白）。
 *
 * v0.26：`明细` 是 ④ 的第四个标签，**在面板里就地换内容**——
 * 前三个标签切数据范围（平铺流水），第四个切视图（月导航 + 按日分组）。
 * 视图与范围是两套状态：点 `明细` 只换视图、不动 `range`；点前三个任意一个回到平铺并切范围。
 * ③ 积分在 ④ 之外，两种视图下都始终在。没有整窗明细页、没有视图要提升到 index.tsx。
 */

const RANGES = ['today', 'week', 'month'] as const

/** ④ 的两种内容：平铺流水（`list`）与按月的明细（`ledger`） */
type PointsView = 'list' | 'ledger'

export function PointsPanel(): ReactElement {
  const { balance, todayPoints, weekPoints, bars, entries, range, setRange } = usePointsData()
  const [view, setView] = useState<PointsView>('list')

  /** 点前三个标签：回到平铺流水并切范围（视图与范围各改一次，互不覆盖） */
  const showRange = (target: LedgerRange): void => {
    setView('list')
    setRange(target)
  }

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
            <span className="points-bar" key={bar.day} style={{ height: `${bar.ratio * 100}%` }} />
          ))}
        </div>
      </section>

      <section className="points-ledger">
        <div className="points-tabs">
          {RANGES.map(item => (
            <button
              aria-pressed={view === 'list' && item === range}
              className={
                view === 'list' && item === range ? 'points-tab points-tab--on' : 'points-tab'
              }
              key={item}
              onClick={() => showRange(item)}
              type="button"
            >
              {RANGE_LABEL[item]}
            </button>
          ))}
          <button
            aria-pressed={view === 'ledger'}
            className={view === 'ledger' ? 'points-tab points-tab--on' : 'points-tab'}
            onClick={() => setView('ledger')}
            type="button"
          >
            {LEDGER_VIEW_LABEL}
          </button>
        </div>
        {view === 'ledger' ? (
          <LedgerView onOpenTask={emitFocusTask} />
        ) : (
          <ul className="ledger-list">
            {entries.map(entry => (
              <li key={entry.id}>
                <button
                  className={
                    entry.reversedAt === null ? 'ledger-row' : 'ledger-row ledger-row--reversed'
                  }
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
        )}
      </section>
    </div>
  )
}
