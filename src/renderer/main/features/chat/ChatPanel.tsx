import { useMemo } from 'react'
import type { ReactElement } from 'react'
import '../../../shared/styles/chat.css'
import { ChatInput } from '../../components/ChatInput'
import { SubmitCard } from '../../components/SubmitCard'
import { MessageList } from './MessageList'
import type { ChatLayer } from './layerModel'
import { layersOfMessages, messagesOfLayer } from './layerModel'
import { toEvidenceViews } from './chatViewModel'
import { useChatData } from './useChatData'

/** 任务层不翻页（v0.69）：分页按消息条数切，卡片被滤掉后页码没有意义，且卡片总量天生很少 */
const noLoadMore = (): void => {}

/**
 * 会话区外壳：消息流（弹性，含末尾待提交卡）+ 输入区（固定）。
 * 数据全部来自 useChatData。
 *
 * v0.39 §2：待提交卡从"消息流与输入区之间的独立区"改成 `MessageList` 的 `tail` 行——
 * 与消息同列、跟着消息一起滚，不再有分隔区。加的是**一行参与测量的内容**，
 * 不是塞进滚动容器的一块固定 div（36 §7 的结论没被推翻）。
 * 没有 tail 时 `MessageList` 的 total / 窗口 / 滚动行为与之前完全一致。
 *
 * v0.69：文字气泡与任务卡分成两层，底部模式按钮顺带决定看哪一层。
 * **只挂当前层那一个 `MessageList`**——两个都挂再 `display:none` 会白跑两套
 * ResizeObserver 与窗口计算。输入区在分层之外，切层不卸载，草稿与附件不会丢。
 * v0.69（72）：分层按「轮」判——任务模式那一轮的文字也归任务层。判定用**全量**
 * `data.messages`（含被隐藏的旧审核卡），渲染仍用 `visibleMessages`。
 * v0.73：消息已带发送模式标签（`messages.mode`），分层优先读标签，只有老行（无标签）才按轮推断。
 */
export function ChatPanel(): ReactElement {
  const data = useChatData()
  // 模式按钮的语义没变（决定发给主进程按 chat 还是 parse 解析），这里只是让它顺带选层
  const layer: ChatLayer = data.mode === 'chat' ? 'chat' : 'task'
  const layers = useMemo(() => layersOfMessages(data.messages), [data.messages])
  const chatMessages = messagesOfLayer(data.visibleMessages, layers, 'chat')
  const taskMessages = messagesOfLayer(data.visibleMessages, layers, 'task')

  // 聊天层的空状态沿用原文案；任务层没有卡片时留白（不新增任何提示）
  const chatEmpty = layer === 'chat' && chatMessages.length === 0

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
            onAddText={text => data.actions.addTextEvidence(task.id, text)}
            onPick={file => data.actions.addEvidence(task.id, file)}
            onRemove={index => data.actions.removeEvidence(task.id, index)}
            onSubmit={() => data.actions.submitReview(task.id)}
            task={task}
          />
        ))}
      </div>
    ) : null

  return (
    <section className="chat-panel">
      {chatEmpty ? (
        <div className="chat-empty">发我一段话或一张图，我把它变成任务。</div>
      ) : (
        <MessageList
          // 换层就重挂：两层的测量表与滚动位置互不相干，留着上一层的只会互相污染
          key={layer}
          actions={data.actions}
          draftViews={data.draftViews}
          hasMore={layer === 'chat' ? data.hasMore : false}
          loadingMore={layer === 'chat' ? data.loadingMore : false}
          messages={layer === 'chat' ? chatMessages : taskMessages}
          onLoadMore={layer === 'chat' ? data.loadMore : noLoadMore}
          reviewViews={data.reviewViews}
          runningUserId={data.runningUserId}
          tail={layer === 'task' ? tail : null}
        />
      )}
      <ChatInput
        mode={data.mode}
        onPendingTextUsed={data.consumeCompose}
        onSend={(text, files) => data.send(text, files, data.mode)}
        onToggleMode={data.toggleMode}
        pendingText={data.composeText}
        sending={data.sending}
      />
    </section>
  )
}
