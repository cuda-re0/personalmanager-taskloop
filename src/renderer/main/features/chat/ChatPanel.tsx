import type { ReactElement } from 'react'
import '../../../shared/styles/chat.css'
import { ChatInput } from '../../components/ChatInput'
import { SubmitCard } from '../../components/SubmitCard'
import { MessageList } from './MessageList'
import { toEvidenceViews } from './chatViewModel'
import { useChatData } from './useChatData'

/**
 * 会话区外壳：消息流（弹性）+ 待提交卡（可滚动，最多 42% 高）+ 输入区（固定）。
 * 数据全部来自 useChatData。
 *
 * 待提交卡插在 `MessageList` 与 `ChatInput` 之间而不是消息流内部：`MessageList` 是
 * 绝对定位的虚拟滚动容器，塞非消息内容会把它的测量搞坏（36 §7）。
 */
export function ChatPanel(): ReactElement {
  const data = useChatData()
  const empty = data.messages.length === 0

  return (
    <section className="chat-panel">
      {empty ? (
        <div className="chat-empty">发我一段话或一张图，我把它变成任务。</div>
      ) : (
        <MessageList
          actions={data.actions}
          draftViews={data.draftViews}
          hasMore={data.hasMore}
          loadingMore={data.loadingMore}
          messages={data.messages}
          onLoadMore={data.loadMore}
          reviewViews={data.reviewViews}
        />
      )}
      {data.pendingSubmit.length > 0 ? (
        <div className="submit-list">
          {data.pendingSubmit.map(task => (
            <SubmitCard
              busy={data.submittingIds.has(task.id)}
              evidence={toEvidenceViews(task.evidence, data.attachmentById)}
              key={task.id}
              onCancel={() => data.actions.cancelSubmit(task.id)}
              onPick={file => data.actions.addEvidence(task.id, file)}
              onSubmit={() => data.actions.submitReview(task.id)}
              task={task}
            />
          ))}
        </div>
      ) : null}
      <ChatInput onSend={data.send} sending={data.sending} />
    </section>
  )
}
