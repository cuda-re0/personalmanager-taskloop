import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'

/** 类型探针：HUD 渲染进程同样要能解析 `@shared`（与主窗各配一份，别只配一个） */
export type DomainTask = Task

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <div className="hud-shell" />
  </StrictMode>
)

console.log(`[renderer:hud] RUBRIC_VERSION=${RUBRIC_VERSION}`)
