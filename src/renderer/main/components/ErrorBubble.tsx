import type { ReactElement } from 'react'

interface Props {
  text: string
  retryable: boolean
  onRetry(): void
}

/** 04 §3.1：system / error 左侧灰底卡，带 [重试]，不阻断会话 */
export function ErrorBubble({ text, retryable, onRetry }: Props): ReactElement {
  return (
    <div className="error-card">
      <span className="error-text">{text}</span>
      {retryable ? (
        <button className="btn btn--ghost" onClick={onRetry} type="button">
          重试
        </button>
      ) : null}
    </div>
  )
}
