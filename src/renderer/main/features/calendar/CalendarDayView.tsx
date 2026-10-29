import type { ReactElement } from 'react'
import { floorTitle } from './calendarModel'
import { useDayOccurrences } from './useCalendarData'
import './calendar.css'

/**
 * 「日历层」（04 §4② v0.28）：点日历某天后，③④ 积分面板整块被本组件**就地替换**
 * （同 v0.26 明细标签的替换模式：不弹层、不覆盖、不新窗口）。
 *
 * 内容 = 那一天的任务 + 完成情况：每行 = 完成状态勾（空心=未完成、实心=已完成，
 * 复用 ① 的 `.task-check` / `.task-check--on`）+ 任务标题。勾是状态显示不是打卡控件
 * （打卡在 ①），不加「完成/未完成」文字、不加统计（§1 文案纪律）。
 *
 * 点行 → 高亮 ① 对应任务，本层**不关**；关闭路径只有「再点同一天」（index 的 toggle）。
 * 数据在挂载时拉取（useDayOccurrences），没选日子本组件不存在、零请求。
 *
 * 高度配额与 `.points-panel` 相同（04 §4① v0.29 比例模型：吃下半块剩余、层内滚动）。
 */
export function CalendarDayView({ day }: { day: string }): ReactElement {
  const rows = useDayOccurrences(day)

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
          <li key={row.occurrenceId}>
            <button
              className={`calendar-row${row.done ? ' calendar-row--done' : ''}`}
              onClick={() => focusTask(row.taskId)}
              type="button"
            >
              <span aria-hidden className={row.done ? 'task-check task-check--on' : 'task-check'} />
              <span className="calendar-row-title">{row.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
