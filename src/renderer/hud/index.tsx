import '../shared/styles/tokens.css'
import './hud.css'
import { StrictMode, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'
import { DockBar } from './DockBar'
import { FloatPod } from './FloatPod'
import { useHudData } from './useHudData'

/** 类型探针：HUD 渲染进程同样要能解析 `@shared`（与主窗各配一份，别只配一个） */
export type DomainTask = Task

/**
 * HUD 入口（W9 · 04 §5）。
 *
 * 两个渲染进程完全独立：这里自己取 bootstrap、自己吃 DomainEvent，
 * **不读主窗的组件状态**（04 §5.5）。形态由主进程的 `hud.getState()` 定，
 * 切换走 `hud.mode.changed` 事件，窗口不重建。
 */
function HudRoot(): ReactElement {
  const data = useHudData()
  return (
    <div className="hud-root">
      {data.ready && (data.mode === 'dock-bar' ? <DockBar data={data} /> : <FloatPod data={data} />)}
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <HudRoot />
  </StrictMode>
)

console.log(`[renderer:hud] RUBRIC_VERSION=${RUBRIC_VERSION}`)
