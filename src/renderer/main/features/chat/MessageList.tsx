import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ReactElement, ReactNode, TouchEvent, WheelEvent } from 'react'
import type { Message } from '@shared/types/domain'
import { MessageItem } from './MessageItem'
import type { ChatActions, DraftView, ReviewView } from './chatTypes'

/** 未测量行的高度估算值；测到真值后会被替换 */
const EST = 88
const OVERSCAN = 4
/** 距底阈值：小于它就算「回到底了」，恢复自动跟随 */
const BOTTOM_THRESHOLD = 24
/** 距顶阈值：小于它且用户确实在上滚，才触发翻页 */
const LOAD_MORE_THRESHOLD = 240

interface Props {
  messages: Message[]
  draftViews: Record<string, DraftView>
  reviewViews: Record<string, ReviewView>
  actions: ChatActions
  hasMore: boolean
  loadingMore: boolean
  onLoadMore(): void
}

interface RowProps {
  id: string
  top: number
  onMeasure(id: string, height: number): void
  children: ReactNode
}

function Row({ id, top, onMeasure, children }: RowProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = (): void => onMeasure(id, el.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, onMeasure])

  return (
    <div className="msg-row" ref={ref} style={{ transform: `translateY(${top}px)` }}>
      {children}
    </div>
  )
}

/**
 * 会话消息流：自写窗口化（不装 react-virtual）+ 自动滚底 + 向上翻页。
 *
 * 「是否贴底」不看 scrollHeight —— 用 wheel / touchmove 维护 atBottom ref：
 * 用户主动上滚立刻置 false，距底回到阈值内才置 true。
 * 翻页时先记下插入前的 total 与 scrollTop，插入后按差值补 scrollTop，避免跳动。
 */
export function MessageList({
  messages,
  draftViews,
  reviewViews,
  actions,
  hasMore,
  loadingMore,
  onLoadMore
}: Props): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const heights = useRef(new Map<string, number>())
  const atBottom = useRef(true)
  const scrolledUp = useRef(false)
  const anchor = useRef<{ total: number; top: number } | null>(null)
  const touchY = useRef(0)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewport(el.clientHeight)
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const measure = useCallback((id: string, height: number) => {
    const prev = heights.current.get(id)
    if (prev !== undefined && Math.abs(prev - height) < 0.5) return
    heights.current.set(id, height)
    bump()
  }, [])

  const offsets = new Array<number>(messages.length)
  let total = 0
  for (let i = 0; i < messages.length; i++) {
    offsets[i] = total
    total += heights.current.get(messages[i].id) ?? EST
  }

  const indexAt = (y: number): number => {
    if (messages.length === 0) return 0
    let lo = 0
    let hi = messages.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const first = Math.max(0, indexAt(scrollTop) - OVERSCAN)
  const last = Math.min(messages.length - 1, indexAt(scrollTop + viewport) + OVERSCAN)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const pending = anchor.current
    if (pending) {
      anchor.current = null
      if (total > pending.total) {
        el.scrollTop = pending.top + (total - pending.total)
        return
      }
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight
  }, [total, messages.length, viewport])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    const distance = total - el.scrollTop - el.clientHeight
    if (distance <= BOTTOM_THRESHOLD) {
      atBottom.current = true
    } else if (distance > BOTTOM_THRESHOLD * 3) {
      // 拖滚动条 / PgUp 这类不经过 wheel 的上滚也要停下跟随
      atBottom.current = false
    }
    if (
      scrolledUp.current &&
      hasMore &&
      !loadingMore &&
      anchor.current === null &&
      el.scrollTop < LOAD_MORE_THRESHOLD
    ) {
      scrolledUp.current = false
      anchor.current = { total, top: el.scrollTop }
      onLoadMore()
    }
  }

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY < 0) {
      atBottom.current = false
      scrolledUp.current = true
    }
  }

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    touchY.current = event.touches[0]?.clientY ?? 0
  }

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
    const y = event.touches[0]?.clientY ?? 0
    if (y > touchY.current + 2) {
      atBottom.current = false
      scrolledUp.current = true
    }
  }

  return (
    <div
      className="msg-scroll"
      onScroll={handleScroll}
      onTouchMove={handleTouchMove}
      onTouchStart={handleTouchStart}
      onWheel={handleWheel}
      ref={scrollRef}
    >
      <div className="msg-spacer" style={{ height: total }}>
        {messages.slice(first, last + 1).map((message: Message, i: number) => (
          <Row
            id={message.id}
            key={message.id}
            onMeasure={measure}
            top={offsets[first + i]}
          >
            <MessageItem
              actions={actions}
              draftViews={draftViews}
              message={message}
              reviewViews={reviewViews}
            />
          </Row>
        ))}
      </div>
    </div>
  )
}
