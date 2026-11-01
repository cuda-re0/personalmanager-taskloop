import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { Message } from '@shared/types/domain'
import { MarkdownText } from '../features/chat/MarkdownText'
import { formatClock } from '../features/chat/chatViewModel'
import { CheckIcon, CopyIcon, FileGlyphIcon, ImageGlyphIcon, PencilIcon, UndoIcon } from './msgIcons'

interface Props {
  message: Message
  /** 有值才渲染「撤回」按钮（自己发的、且不是正在跑的那一轮） */
  onRecall?: () => void
  /** 有值才渲染「编辑」按钮（可见条件同 `onRecall`） */
  onEdit?: () => void
}

/** 复制成功后图标换对勾的时长（v0.49 §5.3） */
const COPIED_MS = 1500

/**
 * 用户/助手气泡（v0.49 §5.2）。
 *
 * 附件是**胶囊**：蓝底图标 + 文件名，鼠标悬停**图片**胶囊才浮出缩略图——
 * 不再在气泡里铺开大图。胶囊不可点击（本单不做点开看图）。
 * 气泡下方**常驻**一行「时间 · 复制 · 撤回 · 编辑」，不做 hover 才显示。
 */
export function TextBubble({ message, onRecall, onEdit }: Props): ReactElement {
  const isUser = message.role === 'user'
  const attachments = message.attachments.slice(0, 4)
  const clock = formatClock(message.createdAt)
  const hasText = message.contentMd.trim().length > 0
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  // 组件卸载要清 setTimeout：复制完 1.5s 内切走再回来，会对着已卸载的组件 setState
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.contentMd)
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setCopied(false)
      }, COPIED_MS)
    } catch (e) {
      // 失败只留日志：图标不变、**不弹任何提示**（v0.49 §5.3）
      console.error('[chat] 复制失败', e)
    }
  }

  return (
    <div className={`msg-line ${isUser ? 'msg-line--user' : 'msg-line--assistant'}`}>
      <div className={`msg-stack ${isUser ? 'msg-stack--user' : 'msg-stack--assistant'}`}>
        <div className={`bubble ${isUser ? 'bubble--user' : 'bubble--assistant'}`}>
          {attachments.length > 0 ? (
            <div className="msg-chips">
              {attachments.map(item => (
                <span className="msg-chip" key={item.id}>
                  <span className="msg-chip-icon">
                    {item.kind === 'image' ? <ImageGlyphIcon /> : <FileGlyphIcon />}
                  </span>
                  {/* 49 之前落库的老行没有名字 → 显示 mime，不造文案 */}
                  <span className="msg-chip-name">{item.name || item.mime}</span>
                  {item.kind === 'image' ? (
                    <span className="msg-chip-pop">
                      <img alt="" src={item.url} />
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          {message.contentMd ? <MarkdownText text={message.contentMd} /> : null}
        </div>
        <div className="msg-actions">
          {clock ? <span className="msg-time">{clock}</span> : null}
          {hasText ? (
            <button aria-label="复制" className="msg-act" onClick={() => void copy()} type="button">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          ) : null}
          {onRecall ? (
            <button aria-label="撤回" className="msg-act" onClick={onRecall} type="button">
              <UndoIcon />
            </button>
          ) : null}
          {onEdit ? (
            <button aria-label="编辑" className="msg-act" onClick={onEdit} type="button">
              <PencilIcon />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
