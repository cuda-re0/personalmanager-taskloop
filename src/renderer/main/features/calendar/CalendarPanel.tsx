import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import {
  WEEKDAY_HEADERS,
  buildMonthGrid,
  dayOf,
  dotStateOf,
  monthTitle,
  toLocalDay
} from './calendarModel'
import { useCalendarData } from './useCalendarData'
import './calendar.css'

/**
 * 右栏②「日历」（04 §4②）：月视图 7 列（周一起始）+ 红点行。
 *
 * 选中态受控：`selectedDay` / `onSelectDay` 由 index.tsx 持有（v0.28）——
 * 选中某天时 ③④ 积分面板整块替换为日历层（CalendarDayView），不在本组件内弹层。
 * 再点同一天由 index 的 toggle 置空关闭；点其他天直接切换。
 *
 * 可见文字只有字段值与 04 已登记的固定标签：
 * 月份（`2026 年 10 月`）、星期（`一`…`日`）、日期数字。不加图例、不加说明文字。
 *
 * v0.94.2 起日历可折叠：头部右侧多一个箭头按钮，折叠态只留标题行，状态记 localStorage
 * （`taskloop:calendar:collapsed`）；展开态网格内部可滚动（`.calendar-grid` 自己 overflow-y），
 * 窗口变矮时不再把日期行顶到下面面板上去。
 */

/** 折叠状态键：只存 '1' / '0'，缺省 = 展开 */
const COLLAPSED_KEY = 'taskloop:calendar:collapsed'

export function CalendarPanel({
  selectedDay,
  onSelectDay
}: {
  selectedDay: string | null
  onSelectDay(day: string): void
}): ReactElement {
  const { year, month, index, actions } = useCalendarData()
  const grid = useMemo(() => buildMonthGrid(year, month), [year, month])
  const today = toLocalDay(new Date())
  const [collapsed, setCollapsed] = useState<boolean>(
    () => window.localStorage.getItem(COLLAPSED_KEY) === '1'
  )

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
  }

  return (
    <section className={collapsed ? 'calendar-panel calendar-panel--collapsed' : 'calendar-panel'}>
      <div className="calendar-head">
        <button
          aria-label="上个月"
          className="calendar-nav"
          onClick={actions.prevMonth}
          type="button"
        >
          ‹
        </button>
        <span className="calendar-title">{monthTitle(year, month)}</span>
        <div className="calendar-head-right">
          <button
            aria-label="下个月"
            className="calendar-nav"
            onClick={actions.nextMonth}
            type="button"
          >
            ›
          </button>
          <button
            aria-label={collapsed ? '展开日历' : '折叠日历'}
            className="calendar-fold"
            onClick={() => toggle()}
            type="button"
          >
            <svg
              aria-hidden
              fill="none"
              height="10"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.5"
              viewBox="0 0 10 10"
              width="10"
            >
              <path d={collapsed ? 'M2 3.5 L5 6.5 L8 3.5' : 'M2 6.5 L5 3.5 L8 6.5'} />
            </svg>
          </button>
        </div>
      </div>

      <div className="calendar-weekdays">
        {WEEKDAY_HEADERS.map(w => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div
        className="calendar-grid"
        style={{ gridTemplateRows: `repeat(${grid.weeks.length}, 1fr)` }}
      >
        {grid.weeks.map((week, wi) =>
          week.map((dayNum, di) => {
            const key = `${wi}-${di}`
            if (dayNum === null)
              return <div className="calendar-cell calendar-cell--blank" key={key} />
            const day = dayOf(year, month, dayNum)
            const dot = dotStateOf(index.get(day))
            const cls = [
              'calendar-cell',
              dot === 'none' ? '' : 'calendar-cell--marked',
              day === today ? 'calendar-cell--today' : '',
              day === selectedDay ? 'calendar-cell--open' : ''
            ]
              .filter(Boolean)
              .join(' ')
            // 任意日期都可点（04 §4② v0.21）；再点同一天由 index 的 toggle 关闭（v0.28）
            return (
              <button
                aria-pressed={day === selectedDay}
                className={cls}
                key={key}
                onClick={() => onSelectDay(day)}
                type="button"
              >
                <span className="calendar-daynum">{dayNum}</span>
                <span className="calendar-dotrow" aria-hidden>
                  {dot === 'none' ? null : <span className={`calendar-dot calendar-dot--${dot}`} />}
                </span>
              </button>
            )
          })
        )}
      </div>
    </section>
  )
}
