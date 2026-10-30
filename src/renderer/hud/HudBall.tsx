import type { CSSProperties, ReactElement } from 'react'
import { completionRatio, ratioLabel, weekdayLabel } from './hudModel'
import type { HudData } from './useHudData'

/**
 * 长条态（04 §5.2 v0.31：132×40 胶囊）。窗口尺寸由主进程定，这里只画。
 *
 * 形态值仍叫 `ball`（`hud.mode` 存的是形态标识，改值域要动旧库归一与契约）——
 * 视觉上从 56×56 圆球换成长条：左侧 20×20 进度环 → 完成数/总数 → 星期。
 *
 * 拖动与点击的冲突沿用 v0.21 的结论（开工词「坑 1」）：
 * **`-webkit-app-region: drag` 的区域收不到 click**，所以整条可拖、另铺一层
 * `no-drag` 的透明热区 `.hud-hit` 承接"点它展开"。没有这块热区，点长条永远不会触发。
 *
 * 文案：环只表达比例，数字是 `ratioLabel()`、星期是 `weekdayLabel()`，
 * 组件里没有一个汉字字面量（04 §5.3 的文字白名单）。
 */

const RING_RADIUS = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function HudBall({ data }: { data: HudData }): ReactElement {
  const ratio = completionRatio(data.done, data.total)

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
      {/* 整条热区（drag 区收不到 click，只能靠它点开） */}
      <button
        type="button"
        className="hud-hit"
        onClick={() => data.actions.setMode('panel')}
        aria-label="展开悬浮窗"
      />
    </div>
  )
}
