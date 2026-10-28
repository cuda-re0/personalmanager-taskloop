import type { ReactElement } from 'react'
import type { ChatActions } from '../features/chat/chatTypes'
import { offsetLabel } from '../features/chat/chatViewModel'

interface Props {
  title: string
  fireAt: string
  /** null = 绝对时间（每日任务按 dailyTime 触发），显示时刻；否则显示「前 1 小时」 */
  offsetMin: number | null
  taskId: string | null
  reminderId: string
  actions: ChatActions
}

function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 04 §3.1 + §9.4：居中细条、无气泡，--dot 小圆点，点击跳任务，hover 出「稍后提醒」 */
export function ReminderRow({
  title,
  fireAt,
  offsetMin,
  taskId,
  reminderId,
  actions
}: Props): ReactElement {
  const clock = clockOf(fireAt)
  const suffix = offsetMin === null ? (clock ? ` · ${clock}` : '') : ` · ${offsetLabel(offsetMin)}`
  return (
    <div className="reminder-row">
      <span className="reminder-dot" />
      <button
        className="reminder-text"
        disabled={taskId === null}
        onClick={() => {
          if (taskId) actions.openTask(taskId)
        }}
        type="button"
      >
        {title}
        {suffix}
      </button>
      <button
        className="reminder-snooze"
        onClick={() => actions.snoozeReminder(reminderId)}
        type="button"
      >
        稍后提醒
      </button>
    </div>
  )
}
