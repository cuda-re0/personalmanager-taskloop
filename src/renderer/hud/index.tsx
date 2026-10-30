import '../shared/styles/tokens.css'
import './hud.css'
import { StrictMode, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'
import { HudBall } from './HudBall'
import { HudPanel } from './HudPanel'
import { useHudData } from './useHudData'

/** 类型探针：HUD 渲染进程同样要能解析 `@shared`（与主窗各配一份，别只配一个） */
export type DomainTask = Task

/**
 * HUD 入口（W9 · 04 §5 v0.30）。
 *
 * 两个渲染进程完全独立：这里自己取 bootstrap、自己吃 DomainEvent，
 * **不读主窗的组件状态**（04 §5.5）。形态由主进程定（`hud.getState()` + `hud.mode.changed`），
 * 切换只换渲染内容，窗口不重建。
 */
function HudRoot(): ReactElement {
  const data = useHudData()
  const shell = data.mode === 'ball' ? 'hud-root hud-root--ball' : 'hud-root hud-root--panel'

  return (
    <div className={shell}>
      {data.ready ? data.mode === 'ball' ? <HudBall data={data} /> : <HudPanel data={data} /> : null}
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
