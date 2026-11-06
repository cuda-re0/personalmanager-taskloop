import { useState, type ReactElement } from 'react'
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

/** 04 §3.1 + §9.4：居中细条、无气泡，--dot 小圆点，点击跳任务，两个按钮常显 */
export function ReminderRow({
  title,
  fireAt,
  offsetMin,
  taskId,
  reminderId,
  actions
}: Props): ReactElement {
  /** 一个状态管两件事：文字转灰 + 两个按钮一起从 DOM 移除。不落库，重启后按钮会再出现 */
  const [settled, setSettled] = useState(false)
  const clock = clockOf(fireAt)
  const suffix = offsetMin === null ? (clock ? ` · ${clock}` : '') : ` · ${offsetLabel(offsetMin)}`
  return (
    <div className={settled ? 'reminder-row is-settled' : 'reminder-row'}>
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
      {settled ? null : (
        <>
          <button
            className="reminder-snooze"
            onClick={() => {
              actions.snoozeReminder(reminderId)
              setSettled(true)
            }}
            type="button"
          >
            稍后提醒
          </button>
          <button
            className="reminder-ack"
            onClick={() => {
              actions.ackAlert(reminderId)
              setSettled(true)
            }}
            type="button"
          >
            知道了
          </button>
        </>
      )}
    </div>
  )
}
