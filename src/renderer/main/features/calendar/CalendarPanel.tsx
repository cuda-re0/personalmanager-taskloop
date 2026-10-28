import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { fmtPoints } from '@shared/format'
import type { DayTaskItem } from '@shared/types/domain'
import { TYPE_LABEL } from '../chat/chatViewModel'
import {
  WEEKDAY_HEADERS,
  buildMonthGrid,
  dayOf,
  dotStateOf,
  floorTitle,
  monthTitle,
  toLocalDay
} from './calendarModel'
import { useCalendarData } from './useCalendarData'
import './calendar.css'

/**
 * 右栏②「日历」（04 §4②）：月视图 7 列（周一起始）+ 红点行 + 按日展开浮层。
 *
 * 可见文字只有字段值与 04 已登记的固定标签：
 * 月份（`2026 年 10 月`）、星期（`一`…`日`）、日期数字、浮层标题（`10 月 27 日 周二`）、
 * 任务标题、`HH:mm`、类型标签（04 §4① 的 `每日/限时/活动`，日历里只会出现后两者）、`N 分`。
 * 不加图例、不加说明文字；空列表留白（04 §7）。
 */

const ROW_META_SEP = ' · '

function FloorRow({
  item,
  onSelect
}: {
  item: DayTaskItem
  onSelect(taskId: string): void
}): ReactElement {
  const done = item.status === 'done'
  // 类型标签 + 分值（04 §4② 行格式）；分值为 null 时只给类型，不写占位符
  const meta =
    item.points === null
      ? TYPE_LABEL[item.type]
      : `${TYPE_LABEL[item.type]}${ROW_META_SEP}${fmtPoints(item.points)} 分`
  return (
    <li>
      <button
        className={`calendar-row${done ? ' calendar-row--done' : ''}`}
        onClick={() => onSelect(item.taskId)}
        type="button"
      >
        <span className="calendar-row-time">{item.time}</span>
        <span className="calendar-row-title">{item.title}</span>
        <span className="calendar-row-meta">{meta}</span>
      </button>
    </li>
  )
}

export function CalendarPanel(): ReactElement {
  const { year, month, index, selectedDay, detail, actions } = useCalendarData()
  const grid = useMemo(() => buildMonthGrid(year, month), [year, month])
  const today = toLocalDay(new Date())
  const rootRef = useRef<HTMLElement | null>(null)

  // 点外部关闭（04 §4②）。点日历块内的另一天由格子自己处理，不在这里关
  useEffect(() => {
    if (!selectedDay) return
    const onPointerDown = (e: PointerEvent): void => {
      const root = rootRef.current
      if (root && e.target instanceof Node && root.contains(e.target)) return
      actions.close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [selectedDay, actions])

  return (
    <section className="calendar-panel" ref={rootRef}>
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
        <button
          aria-label="下个月"
          className="calendar-nav"
          onClick={actions.nextMonth}
          type="button"
        >
          ›
        </button>
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
            const content = (
              <>
                <span className="calendar-daynum">{dayNum}</span>
                <span className="calendar-dotrow" aria-hidden>
                  {dot === 'none' ? null : <span className={`calendar-dot calendar-dot--${dot}`} />}
                </span>
              </>
            )
            // 无红点的日期不响应，也不做成可聚焦控件（04 §4② / 05 W6B 验收）
            return dot === 'none' ? (
              <div className={cls} key={key}>
                {content}
              </div>
            ) : (
              <button
                className={cls}
                key={key}
                onClick={() => actions.selectDay(day)}
                type="button"
              >
                {content}
              </button>
            )
          })
        )}
      </div>

      {selectedDay ? (
        <div className="calendar-floor">
          <div className="calendar-floor-head">
            <span>{floorTitle(selectedDay)}</span>
            <button
              aria-label="关闭"
              className="calendar-floor-close"
              onClick={actions.close}
              type="button"
            >
              ×
            </button>
          </div>
          <ul
            className={`calendar-floor-list${detail.length === 0 ? ' calendar-floor-list--empty' : ''}`}
          >
            {detail.map(item => (
              <FloorRow item={item} key={item.taskId} onSelect={actions.focusTask} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
