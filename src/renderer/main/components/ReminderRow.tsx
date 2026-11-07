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
  /** v0.92：消息 id，两个按钮都把它交给主进程写 settled_at */
  messageId: string
  /** v0.92：已处理（`messages.settled_at` 非 null）。灰字 + 两个按钮不进 DOM */
  acked: boolean
  actions: ChatActions
}

function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 04 §3.1 + §9.4：居中细条、无气泡，--dot 小圆点，点击跳任务，两个按钮常显。
 *
 * v0.92：组件自己不存状态——「处理过没有」落库在 `messages.settled_at`，
 * 由 `acked` 驱动显示；主进程写完广播 `message.patch`，重启/切页都还是灰的。
 */
export function ReminderRow({
  title,
  fireAt,
  offsetMin,
  taskId,
  reminderId,
  messageId,
  acked,
  actions
}: Props): ReactElement {
  const clock = clockOf(fireAt)
  const suffix = offsetMin === null ? (clock ? ` · ${clock}` : '') : ` · ${offsetLabel(offsetMin)}`
  return (
    <div className={acked ? 'reminder-row is-settled' : 'reminder-row'}>
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
      {acked ? null : (
        <>
          <button
            className="reminder-snooze"
            onClick={() => {
              actions.snoozeReminder(reminderId)
              actions.settleReminder(messageId)
            }}
            type="button"
          >
            稍后提醒
          </button>
          <button
            className="reminder-ack"
            onClick={() => actions.settleReminder(messageId)}
            type="button"
          >
            知道了
          </button>
        </>
      )}
    </div>
  )
}
