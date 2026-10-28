import type { ReactElement } from 'react'
import '../../../shared/styles/chat.css'
import { ChatInput } from '../../components/ChatInput'
import { MessageList } from './MessageList'
import { useChatData } from './useChatData'

/** 会话区外壳：消息流（弹性）+ 输入区（固定）。数据全部来自 useChatData。 */
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
      <ChatInput onSend={data.send} sending={data.sending} />
    </section>
  )
}
