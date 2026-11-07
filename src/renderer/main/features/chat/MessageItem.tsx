import { memo } from 'react'
import type { ReactElement } from 'react'
import type { Message } from '@shared/types/domain'
import { TextBubble } from '../../components/TextBubble'
import { TaskDraftCard } from '../../components/TaskDraftCard'
import { TaskReviewCard } from '../../components/TaskReviewCard'
import { ReminderRow } from '../../components/ReminderRow'
import { ErrorBubble } from '../../components/ErrorBubble'
import type { ChatActions, DraftView, ReviewView } from './chatTypes'

interface Props {
  message: Message
  draftViews: Record<string, DraftView>
  reviewViews: Record<string, ReviewView>
  actions: ChatActions
  /** 正在跑的那一轮的 user 消息 id（v0.48）：这条不给「撤回 / 编辑」按钮 */
  runningUserId: string | null
}

/**
 * 按 `message.meta.kind` 分派，不看 `message.kind` ——
 * 两者是独立的判别式，text 消息的 meta 是 { kind: 'none' }。
 */
export const MessageItem = memo(function MessageItem({
  message,
  draftViews,
  reviewViews,
  actions,
  runningUserId
}: Props): ReactElement | null {
  const meta = message.meta
  switch (meta.kind) {
    case 'task_draft':
      return (
        <div className="msg-drafts">
          {meta.drafts.map(item => {
            const view = draftViews[item.localId]
            return view ? <TaskDraftCard actions={actions} key={item.localId} view={view} /> : null
          })}
        </div>
      )
    case 'task_review': {
      const view = reviewViews[message.id]
      return view ? <TaskReviewCard actions={actions} verdict={meta.verdict} view={view} /> : null
    }
    case 'reminder':
      return (
        <ReminderRow
          actions={actions}
          acked={message.settledAt !== null}
          fireAt={meta.fireAt}
          messageId={message.id}
          offsetMin={meta.offsetMin}
          reminderId={meta.reminderId}
          taskId={meta.taskId}
          title={meta.title}
        />
      )
    case 'error':
      return (
        <ErrorBubble
          onRetry={() => actions.retry(message.id)}
          retryable={meta.retryable}
          text={meta.message}
        />
      )
    case 'none':
    default: {
      // 撤回 / 编辑只给自己发的、且不是正在跑的那一轮（48 §5.5）
      const editable = message.role === 'user' && message.id !== runningUserId
      return (
        <TextBubble
          message={message}
          onEdit={editable ? () => actions.editMessage(message.id) : undefined}
          onRecall={editable ? () => actions.recallMessage(message.id) : undefined}
        />
      )
    }
  }
})
