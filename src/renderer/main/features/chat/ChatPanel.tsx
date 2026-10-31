import type { ReactElement } from 'react'
import '../../../shared/styles/chat.css'
import { ChatInput } from '../../components/ChatInput'
import { SubmitCard } from '../../components/SubmitCard'
import { MessageList } from './MessageList'
import { toEvidenceViews } from './chatViewModel'
import { useChatData } from './useChatData'

/**
 * 会话区外壳：消息流（弹性，含末尾待提交卡）+ 输入区（固定）。
 * 数据全部来自 useChatData。
 *
 * v0.39 §2：待提交卡从"消息流与输入区之间的独立区"改成 `MessageList` 的 `tail` 行——
 * 与消息同列、跟着消息一起滚，不再有分隔区。加的是**一行参与测量的内容**，
 * 不是塞进滚动容器的一块固定 div（36 §7 的结论没被推翻）。
 * 没有 tail 时 `MessageList` 的 total / 窗口 / 滚动行为与之前完全一致。
 */
export function ChatPanel(): ReactElement {
  const data = useChatData()
  // 有卡即使没有消息也要渲染消息流——否则空对话里待提交卡会整块消失
  const empty = data.messages.length === 0 && data.pendingSubmit.length === 0

  const tail =
    data.pendingSubmit.length > 0 ? (
      <div className="submit-tail">
        {data.pendingSubmit.map(task => (
          <SubmitCard
            busy={data.submittingIds.has(task.id)}
            evidence={toEvidenceViews(task.evidence, data.attachmentById)}
            gaps={data.reviewGaps[task.id] ?? []}
            hint={data.needEvidenceHint[task.id] ?? null}
            key={task.id}
            onCancel={() => data.actions.cancelSubmit(task.id)}
            onPick={file => data.actions.addEvidence(task.id, file)}
            onSubmit={() => data.actions.submitReview(task.id)}
            task={task}
          />
        ))}
      </div>
    ) : null

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
          messages={data.visibleMessages}
          onLoadMore={data.loadMore}
          reviewViews={data.reviewViews}
          tail={tail}
        />
      )}
      <ChatInput
        mode={data.mode}
        onSend={(text, attachments) => data.send(text, attachments, data.mode)}
        onToggleMode={data.toggleMode}
        sending={data.sending}
      />
    </section>
  )
}
