import { useEffect, type ReactElement } from 'react'
import { completionRatio } from './hudModel'
import { HudPanel } from './HudPanel'
import type { HudData } from './useHudData'

/**
 * 模式 B：`float-pod`（04 §5.3）。
 *
 * 收起态是 56×56 的圆：整块可拖（`-webkit-app-region: drag`），
 * **但 drag 区域收不到 click**（开工词「坑 1」），所以"点击展开"必须挂在圆心的 no-drag 热区上，
 * 否则永远不会触发。松手后的坐标吸附在主进程 `move` 去抖里做，这里不参与。
 *
 * 展开态是 360×480 面板（尺寸由主进程 setBounds）：ESC 收起；窗口失焦（点到 HUD 外面）也收起。
 */

const RING_RADIUS = 24
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function PodCircle({ data }: { data: HudData }): ReactElement {
  const ratio = completionRatio(data.done, data.total)
  return (
    <div className="pod">
      <svg className="pod-ring" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r={RING_RADIUS} className="pod-ring-track" />
        <circle
          cx="28"
          cy="28"
          r={RING_RADIUS}
          className="pod-ring-value"
          strokeDasharray={`${ratio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 28 28)"
        />
      </svg>
      {/* 圆心 no-drag 热区（约 60% 直径）：drag 区收不到 click，只能靠它 */}
      <button
        type="button"
        className="pod-hot"
        onClick={() => data.actions.setExpanded(true)}
        aria-label="展开悬浮窗"
      />
      {data.pending > 0 ? <span className="pod-badge">{data.pending}</span> : null}
    </div>
  )
}

export function FloatPod({ data }: { data: HudData }): ReactElement {
  const setExpanded = data.actions.setExpanded

  useEffect(() => {
    if (!data.expanded) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    // 点到 HUD 外面 → 窗口失焦 → 收起（04 §5.3「再次点击外部/ESC 收起」）
    const onBlur = (): void => setExpanded(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [data.expanded, setExpanded])

  if (!data.expanded) return <PodCircle data={data} />

  return (
    <div className="pod-panel">
      <HudPanel data={data} variant="panel" />
    </div>
  )
}
