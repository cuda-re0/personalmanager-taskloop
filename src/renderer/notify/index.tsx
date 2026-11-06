import '../shared/styles/tokens.css'
import './notify.css'
import { StrictMode, useCallback, useEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { NotifyPayload } from '@shared/types/ipc'
import { ReminderNotice } from './ReminderNotice'

/**
 * 提醒窗口入口（v0.58，58 §3.5）。
 *
 * 这个渲染进程只干一件事：等主进程推一条 `NotifyPayload`，按 `level` 画成横幅或小窗。
 * 负载里的四个显示值全是主进程算好的，这里**不读时钟、不解析 due_at**——
 * 两个进程各有一套时钟，各算一遍只会在读秒边界上互相打脸。
 *
 * 关窗走 `window.close()`：主进程的 `closed` 事件里接着弹队列里的下一条，
 * 所以这里不需要（也不该有）额外的关闭通道。
 */
function NotifyRoot(): ReactElement | null {
  const [payload, setPayload] = useState<NotifyPayload | null>(null)

  useEffect(() => {
    if (typeof window.api === 'undefined') return
    return window.api.notify.onShow(setPayload)
  }, [])

  /**
   * 关窗前先确认（v0.88）：`window.close()` 会销毁这个渲染进程，先 close 再 ack 必然丢包。
   * 所以等 ack 的 Promise settle 之后才 close，且**无论成败都关**——用户点掉横幅不能被一张表卡住。
   */
  const dismiss = useCallback((): void => {
    const reminderId = payload === null ? null : payload.reminderId
    const close = (): void => window.close()
    if (reminderId === null || typeof window.api === 'undefined') {
      close()
      return
    }
    void window.api.alert
      .ack({ sourceId: reminderId })
      .then(res => {
        if (!res.ok) console.error('[notify] alert.ack 失败', res.error)
      })
      .catch((e: unknown) => console.error('[notify] alert.ack 失败', e))
      .finally(close)
  }, [payload])

  if (payload === null) return null
  return <ReminderNotice onDismiss={dismiss} payload={payload} />
}

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <NotifyRoot />
  </StrictMode>
)
