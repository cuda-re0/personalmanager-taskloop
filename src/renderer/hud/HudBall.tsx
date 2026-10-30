import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  LONG_PRESS_MS,
  TAP_TOLERANCE,
  completionRatio,
  ratioLabel,
  weekdayLabel
} from './hudModel'
import type { HudData } from './useHudData'

/**
 * 长条态（04 §5.2 v0.31：132×40 胶囊；手势见 §5.2.2 v0.32）。窗口尺寸由主进程定，这里只画。
 *
 * 形态值仍叫 `ball`（`hud.mode` 存的是形态标识，改值域要动旧库归一与契约）——
 * 视觉上从 56×56 圆球换成长条：左侧 20×20 进度环 → 完成数/总数 → 星期。
 *
 * 手势（v0.32 用户裁决「点按点击，长按拖动」）：整条**不再用** `-webkit-app-region: drag`——
 * drag 区收不到任何鼠标事件，做不到「既点又拖」。改由这里自己判：
 * - 点按（< 260ms 松开、位移 ≤ 4px）→ 展开面板；
 * - 长按（≥ 260ms）→ 进入拖动，指针怎么移窗口就跟到哪；
 * - 手抖（未到 260ms 但位移 > 4px）→ 什么都不做。
 *
 * 位移一律取 `screenX/screenY` 差值：窗口自己也在动，`clientX` 会漂。
 * 拖动中**不判形态**（窗口中途变大会让指针相对位置突变），松手时由主进程判一次。
 *
 * 文案：环只表达比例，数字是 `ratioLabel()`、星期是 `weekdayLabel()`，
 * 组件里没有一个汉字字面量（04 §5.3 的文字白名单）。
 */

const RING_RADIUS = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 一次按压的判定状态；`null` = 当前没有按着 */
interface Gesture {
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** 已过 260ms，进入拖动 */
  dragging: boolean
  /** 未到 260ms 就动超过 4px：本次按压作废（不展开也不拖） */
  cancelled: boolean
}

export function HudBall({ data }: { data: HudData }): ReactElement {
  const ratio = completionRatio(data.done, data.total)
  const [dragging, setDragging] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frame = useRef<number | null>(null)
  /** 尚未发出的位移（每帧最多一次 IPC） */
  const pending = useRef({ dx: 0, dy: 0 })

  const clearHold = (): void => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  const clearFrame = (): void => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }

  /** 把累加的位移发出去；`end` 只由收尾那一次带 true */
  const flush = (end: boolean): void => {
    frame.current = null
    const { dx, dy } = pending.current
    pending.current = { dx: 0, dy: 0 }
    void window.api.hud
      .dragBy({ dx, dy, end })
      .then(res => {
        if (!res.ok) console.error('[hud] hud.dragBy 失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] hud.dragBy 调用失败', e))
  }

  const schedule = (): void => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => flush(false))
  }

  /**
   * 收尾：pointerup / pointercancel / lostpointercapture 共用。
   * `allowTap` 只有真正的 pointerup 才给——取消与丢捕获不展开。
   */
  const finish = (allowTap: boolean): void => {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    clearHold()

    if (g.dragging) {
      clearFrame()
      setDragging(false)
      // 剩余位移连 end 一起发：主进程据此落库 + 判形态
      flush(true)
      return
    }
    if (!allowTap || g.cancelled) return
    if (Math.abs(g.lastX - g.startX) + Math.abs(g.lastY - g.startY) > TAP_TOLERANCE) return
    data.actions.setMode('panel')
  }

  // 组件卸载时别留定时器/帧回调（长按到一半切形态、窗口被隐藏都会走到这里）
  useEffect(
    () => () => {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    []
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    // 捕获指针：移出窗口也要收得到 move/up，否则拖到边上就断了
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      dragging: false,
      cancelled: false
    }
    pending.current = { dx: 0, dy: 0 }
    clearHold()
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null
      const g = gesture.current
      if (!g || g.cancelled) return
      g.dragging = true
      setDragging(true)
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const g = gesture.current
    if (!g) return

    if (!g.dragging) {
      // 手抖：没到 260ms 就动了超过 4px → 作废本次按压
      if (Math.abs(e.screenX - g.startX) + Math.abs(e.screenY - g.startY) > TAP_TOLERANCE) {
        g.cancelled = true
        clearHold()
      }
      g.lastX = e.screenX
      g.lastY = e.screenY
      return
    }

    pending.current = {
      dx: pending.current.dx + (e.screenX - g.lastX),
      dy: pending.current.dy + (e.screenY - g.lastY)
    }
    g.lastX = e.screenX
    g.lastY = e.screenY
    schedule()
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const g = gesture.current
    if (!g) return
    g.lastX = e.screenX
    g.lastY = e.screenY
    finish(true)
  }

  return (
    <div className="hud-ball" style={{ '--hud-bg': data.hudBg } as CSSProperties}>
      <span className="hud-bar-ring">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r={RING_RADIUS} className="hud-bar-track" />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            className="hud-bar-value"
            strokeDasharray={`${ratio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </span>
      <span className="hud-bar-ratio">{ratioLabel(data.done, data.total)}</span>
      <span className="hud-bar-week">{weekdayLabel(new Date())}</span>
      {/* 整条热区：承接 pointer 事件（点击只由 pointerup 判定，这里不挂点击处理器） */}
      <button
        type="button"
        className={dragging ? 'hud-hit is-dragging' : 'hud-hit'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => finish(false)}
        aria-label="展开悬浮窗"
      />
    </div>
  )
}
