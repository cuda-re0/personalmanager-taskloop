import type { CSSProperties, ReactElement } from 'react'
import { completionRatio } from './hudModel'
import type { HudData } from './useHudData'

/**
 * 球态（04 §5.2 v0.30）：56×56 圆，窗口尺寸由主进程定，这里只画。
 *
 * 拖动与点击的冲突沿用 v0.21 的结论（开工词「坑 1」）：
 * **`-webkit-app-region: drag` 的区域收不到 click**，所以整球可拖、圆心留一块
 * `no-drag` 的 34px 热区承接"点球展开"。没有这块热区，点球永远不会触发。
 *
 * 文案：球上没有一个字（04 §5.3 的文字白名单里没有球态文案），进度只由环表达。
 */

const RING_RADIUS = 24
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function HudBall({ data }: { data: HudData }): ReactElement {
  const ratio = completionRatio(data.done, data.total)

  return (
    <div className="hud-ball" style={{ '--hud-bg': data.hudBg } as CSSProperties}>
      <svg className="hud-ball-ring" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r={RING_RADIUS} className="hud-ball-track" />
        <circle
          cx="28"
          cy="28"
          r={RING_RADIUS}
          className="hud-ball-value"
          strokeDasharray={`${ratio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 28 28)"
        />
      </svg>
      {/* 圆心 no-drag 热区（34px ≈ 60% 直径）：drag 区收不到 click，只能靠它 */}
      <button
        type="button"
        className="hud-ball-hot"
        onClick={() => data.actions.setMode('panel')}
        aria-label="展开悬浮窗"
      />
    </div>
  )
}
