import '../shared/styles/tokens.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'
import { ChatPanel } from './features/chat/ChatPanel'
import { TasksPanel } from './features/tasks/TasksPanel'
import { CalendarPanel } from './features/calendar/CalendarPanel'
import { PointsPanel } from './features/points/PointsPanel'

/**
 * 类型探针：`@shared` 别名 + 领域类型在渲染进程必须可用。
 * 后续业务代码直接 `import { Task } from '@shared/types/domain'`，不需要改别名配置。
 */
export type DomainTask = Task

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// 主窗两栏布局（04 §2）：左会话区（弹性）+ 右栏 400px。
// 右栏四区块里已落地 ①「当前任务」（W5）、②「日历」（W6B）；③④ 随 W6 落地。
createRoot(container).render(
  <StrictMode>
    <div className="app-shell">
      <ChatPanel />
      <aside className="right-col">
        <TasksPanel />
        <CalendarPanel />
      </aside>
    </div>
  </StrictMode>
)

console.log(`[renderer:main] RUBRIC_VERSION=${RUBRIC_VERSION}`)
