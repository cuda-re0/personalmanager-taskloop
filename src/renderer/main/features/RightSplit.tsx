import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { ratioFromY } from './splitModel'

/**
 * 右栏分割线（04 §4① v0.29）：水平拖动条，无任何文字（04 §7 文案纪律）。
 * 受控组件——比例状态在 index.tsx，这里拖动中只上报不落盘；
 * pointerup 时经 onCommit 让调用方写一次 localStorage（拖动中不写，§3.3）。
 * 容器几何取 currentTarget.parentElement（即 .right-col），不额外传 ref。
 */
interface RightSplitProps {
  ratio: number
  onChange: (ratio: number) => void
  onCommit: (ratio: number) => void
}

export function RightSplit({ ratio, onChange, onCommit }: RightSplitProps): ReactElement {
  const dragging = useRef(false)
  /** 最近一次 move 的比例：pointerup 时 setState 可能尚未重渲染（闭包里是旧 props），提交必须用它 */
  const latest = useRef(ratio)

  const report = useCallback(
    (r: number): void => {
      latest.current = r
      onChange(r)
    },
    [onChange]
  )

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const container = e.currentTarget.parentElement
    if (!container) return
    dragging.current = true
    // 阻断 pointerdown 的默认行为（拖动时的文本选中）
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!dragging.current) return
      const container = e.currentTarget.parentElement
      if (!container) return
      const rect = container.getBoundingClientRect()
      // flex 分配空间 = 容器减去分割带自身高度：夹限（160/360）与 flexGrow 用同一口径，
      // 否则夹限像素会被分割带吃掉一截（比例分母含 8px 时上半最少只有 152px）
      const band = e.currentTarget.offsetHeight
      report(ratioFromY(e.clientY, { top: rect.top + band, height: rect.height - band }))
    },
    [report]
  )

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!dragging.current) return
      dragging.current = false
      e.currentTarget.releasePointerCapture(e.pointerId)
      onCommit(latest.current)
    },
    [onCommit]
  )

  /**
   * 兜底：pointerup 因异常路径丢失（pointercancel / capture 被系统收回）时，
   * capture 释放必触发本事件——在这里复位拖动位，防止之后的 move 继续改比例。
   * 正常 up 路径本事件也会触发，但 dragging 已复位，是无害空转。
   */
  const handleLostCapture = useCallback((): void => {
    dragging.current = false
  }, [])

  return (
    <div
      className="right-split"
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onLostPointerCapture={handleLostCapture}
    />
  )
}
