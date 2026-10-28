import type { ReactElement } from 'react'
import type { Message } from '@shared/types/domain'
import { MarkdownText } from '../features/chat/MarkdownText'

/** 04 §3.1：user 右对齐主色浅底，assistant 左对齐无底；图片在上、文字在下，最多 4 张 */
export function TextBubble({ message }: { message: Message }): ReactElement {
  const images = message.attachments.filter(item => item.kind === 'image').slice(0, 4)
  const isUser = message.role === 'user'

  return (
    <div className={`msg-line ${isUser ? 'msg-line--user' : 'msg-line--assistant'}`}>
      <div className={`bubble ${isUser ? 'bubble--user' : 'bubble--assistant'}`}>
        {images.length > 0 ? (
          <div className={`bubble-images bubble-images--${images.length}`}>
            {images.map(image => (
              <img alt="" className="bubble-image" key={image.id} src={image.url} />
            ))}
          </div>
        ) : null}
        {message.contentMd ? <MarkdownText text={message.contentMd} /> : null}
      </div>
    </div>
  )
}
