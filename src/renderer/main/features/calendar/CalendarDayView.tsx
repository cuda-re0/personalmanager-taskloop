import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import { TYPE_LABEL } from '../chat/chatViewModel'
import { floorTitle } from './calendarModel'
import { useDayTasks } from './useCalendarData'
import './calendar.css'

/**
 * 「日历层」（04 §4②）：点日历某天后，③④ 积分面板整块被本组件**就地替换**
 * （同 v0.26 明细标签的替换模式：不弹层、不覆盖、不新窗口）。
 *
 * 内容 = 那一天的**限时 / 活动**任务（`calendar.dayDetail`，与红点 `dayIndex` 同口径）。
 * 每行 = 时刻 · 标题 · 类型 · 分值；已完成的行整行降透明度（`.calendar-row--done`），
 * 不加文字、不加统计（§1 文案纪律）。
 *
 * 每日任务**不进这里**：它们归 ① 区「每日」组与会话管理（04 §4② 写死）。混进来会让
 * 日视图只剩打卡，还会和只统计 deadline/event 的红点对不上。
 *
 * 点行 → 高亮 ① 对应任务，本层**不关**；关闭路径只有「再点同一天」（index 的 toggle）。
 * 数据在挂载时拉取（`useDayTasks`），没选日子本组件不存在、零请求。
 *
 * 高度配额与 `.points-panel` 相同（04 §4① v0.29 比例模型：吃下半块剩余、层内滚动）。
 */
export function CalendarDayView({ day }: { day: string }): ReactElement {
  const rows = useDayTasks(day)

  const focusTask = (taskId: string): void => {
    // 集成交接点：接收方是右栏任务面板（①）。派发后本层不关闭（v0.28 与浮层行为不同）
    window.dispatchEvent(new CustomEvent('taskloop:focus-task', { detail: { id: taskId } }))
  }

  return (
    <section className="calendar-dayview">
      <div className="calendar-dayview-head">{floorTitle(day)}</div>
      <ul
        className={`calendar-dayview-list${rows.length === 0 ? ' calendar-dayview-list--empty' : ''}`}
      >
        {rows.map(row => (
          <li key={row.taskId}>
            <button
              className={`calendar-row${row.status === 'done' ? ' calendar-row--done' : ''}`}
              onClick={() => focusTask(row.taskId)}
              type="button"
            >
              {row.time !== '' && <span className="calendar-row-time">{row.time}</span>}
              <span className="calendar-row-title">{row.title}</span>
              <span className="calendar-row-type">{TYPE_LABEL[row.type]}</span>
              {row.points !== null && (
                <span className="calendar-row-points">{fmtPoints(row.points)} 分</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
