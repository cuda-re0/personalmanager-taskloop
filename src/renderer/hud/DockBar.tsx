import { useEffect, useRef, type ReactElement } from 'react'
import { HudPanel } from './HudPanel'
import type { HudData } from './useHudData'

/**
 * 模式 A：`dock-bar`（04 §5.2）。
 *
 * hover 计时在渲染层、改尺寸在主进程（开工词「坑 3」）：
 * 进入 300ms → `setExpanded(true)`，离开 500ms → `setExpanded(false)`；
 * 定时器必须能被下一次进入/离开取消，否则快速划入划出会抖。
 *
 * 窗口高度由主进程 `setBounds` 改，**这里不碰 height**（CSS 改高度会被窗口裁切）。
 */

const EXPAND_DELAY_MS = 300
const COLLAPSE_DELAY_MS = 500

export function DockBar({ data }: { data: HudData }): ReactElement {
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setExpanded = data.actions.setExpanded

  const clearExpand = (): void => {
    if (expandTimer.current) {
      clearTimeout(expandTimer.current)
      expandTimer.current = null
    }
  }
  const clearCollapse = (): void => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current)
      collapseTimer.current = null
    }
  }

  useEffect(
    () => () => {
      clearExpand()
      clearCollapse()
    },
    []
  )

  const onMouseEnter = (): void => {
    clearCollapse()
    clearExpand()
    expandTimer.current = setTimeout(() => {
      expandTimer.current = null
      setExpanded(true)
    }, EXPAND_DELAY_MS)
  }

  const onMouseLeave = (): void => {
    clearExpand()
    clearCollapse()
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null
      setExpanded(false)
    }, COLLAPSE_DELAY_MS)
  }

  return (
    <div
      className={data.expanded ? 'dock-bar is-open' : 'dock-bar'}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <HudPanel data={data} variant="bar" />
    </div>
  )
}
