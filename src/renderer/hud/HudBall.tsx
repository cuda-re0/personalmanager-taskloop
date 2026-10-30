import { useEffect, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { TAP_TOLERANCE, completionRatio, ratioLabel, weekdayLabel } from './hudModel'
import type { HudData } from './useHudData'

/**
 * 长条态（04 §5.2 v0.31：132×40 胶囊；手势见 §5.2.2）。窗口尺寸由主进程定，这里只画。
 *
 * 形态值仍叫 `ball`（`hud.mode` 存的是形态标识，改值域要动旧库归一与契约）——
 * 视觉上从 56×56 圆球换成长条：左侧 20×20 进度环 → 完成数/总数 → 星期。
 *
 * 手势（用户裁决「点按点击，长按拖动」，v0.33 改按下即预备）：
 * 整条**不用** `-webkit-app-region: drag`——drag 区收不到任何鼠标事件，做不到「既点又拖」。
 * 这里自己判，且**没有时间阈值**（按住多久才算拖动会让手一停就发涩）：
 * - 按下 → 立刻 `dragBegin()` 拿长条左上角，算出抓取偏移 `grab = 按下点 − 左上角`；
 *   此时只是**预备**，窗口一动不动；
 * - 位移超过 `TAP_TOLERANCE`(4px) → 进入拖动，指针怎么移窗口就跟到哪（不用等任何时长）；
 * - 松开时位移仍 ≤ 4px → 视为点按，展开面板。
 *
 * 拖动是**绝对定位**：每帧发 `dragTo(指针 − grab)`。不做增量累加——`setBounds` 异步，
 * 读回的是上一帧位置，增量会一帧帧漏，窗口不跟光标、越拖越偏。
 *
 * 位移一律取 `screenX/screenY` 差值：窗口自己也在动，`clientX` 会漂。
 * 拖动中**不判形态**（形态只由主进程在松手时判一次），窗口也就不会在拖动中途变大。
 *
 * 文案：环只表达比例，数字是 `ratioLabel()`、星期是 `weekdayLabel()`，
 * 组件里没有一个汉字字面量（04 §5.3 的文字白名单）。
 */

const RING_RADIUS = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

interface Point {
  x: number
  y: number
}

/** 一次按压的判定状态；`null` = 当前没有按着 */
interface Gesture {
  /** 按下时的屏幕坐标（点按判定 + 算 grab 都用它） */
  startX: number
  startY: number
  /** 最近一次屏幕坐标 */
  lastX: number
  lastY: number
  /** 位移已越过 `TAP_TOLERANCE`，进入拖动 */
  dragging: boolean
  /** 抓取偏移 = 按下点 − 长条左上角；`null` = dragBegin 还没回来 */
  grab: Point | null
  /** 最近一次的绝对目标点；`null` = 还没移动过 */
  target: Point | null
}

export function HudBall({ data }: { data: HudData }): ReactElement {
  const ratio = completionRatio(data.done, data.total)
  const gesture = useRef<Gesture | null>(null)
  const frame = useRef<number | null>(null)

  const clearFrame = (): void => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }

  const send = (point: Point, end: boolean): void => {
    void window.api.hud
      .dragTo({ x: point.x, y: point.y, end })
      .then(res => {
        if (!res.ok) console.error('[hud] hud.dragTo 失败', res.error)
      })
      .catch((e: unknown) => console.error('[hud] hud.dragTo 调用失败', e))
  }

  /** 每帧最多一次 IPC：move 只记目标点，帧回调才发 */
  const schedule = (): void => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const g = gesture.current
      if (!g || !g.dragging || g.target === null) return
      send(g.target, false)
    })
  }

  /**
   * 收尾：pointerup / pointercancel / lostpointercapture 共用。
   * `allowTap` 只有真正的 pointerup 才给——取消与丢捕获不展开。
   */
  const finish = (allowTap: boolean): void => {
    const g = gesture.current
    if (!g) return
    // 先摘掉：pointerup 之后浏览器还会补一个 lostpointercapture，
    // 不先置 null 会把 end:true 发两遍
    gesture.current = null
    clearFrame()

    if (g.dragging) {
      // 没移动过（grab 没回来就松手）就不发：既不需要落库，也没什么可判
      if (g.target !== null) send(g.target, true)
      return
    }
    if (!allowTap) return
    if (Math.abs(g.lastX - g.startX) + Math.abs(g.lastY - g.startY) > TAP_TOLERANCE) return
    data.actions.setMode('panel')
  }

  // 组件卸载时别留帧回调（拖到一半切形态、窗口被隐藏都会走到这里）
  useEffect(() => () => clearFrame(), [])

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    // 捕获指针：移出窗口也要收得到 move/up，否则拖到边上就断了
    e.currentTarget.setPointerCapture(e.pointerId)
    const g: Gesture = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      dragging: false,
      grab: null,
      target: null
    }
    gesture.current = g

    // 按下就取锚点：绝对定位要的是「按下点相对长条左上角的偏移」，
    // 早一步拿到，第一帧位移就能跟手（不用等任何时长）
    void window.api.hud
      .dragBegin()
      .then(res => {
        if (!res.ok) {
          console.error('[hud] hud.dragBegin 失败', res.error)
          return
        }
        // 期间可能已经松手、或换了新的一次按压：不能把 grab 塞到别人身上
        if (gesture.current !== g) return
        g.grab = { x: g.startX - res.data.x, y: g.startY - res.data.y }
        // IPC 往返期间可能已经拖起来了：立刻按最新指针补一帧，
        // 否则要等下一次 move 才动，手感会先顿一下
        if (g.dragging) {
          g.target = { x: g.lastX - g.grab.x, y: g.lastY - g.grab.y }
          schedule()
        }
      })
      .catch((e: unknown) => console.error('[hud] hud.dragBegin 调用失败', e))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const g = gesture.current
    if (!g) return
    g.lastX = e.screenX
    g.lastY = e.screenY

    if (!g.dragging) {
      // 预备态：还没过阈值就一个包都不发，窗口一动不动（点按时不许抖）
      if (Math.abs(e.screenX - g.startX) + Math.abs(e.screenY - g.startY) <= TAP_TOLERANCE) return
      g.dragging = true
    }
    // grab 未就绪就发，会把窗口甩到指针位置上（等于忽略按下的偏移）；回来时会补发
    if (g.grab === null) return
    g.target = { x: e.screenX - g.grab.x, y: e.screenY - g.grab.y }
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
        className="hud-hit"
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
