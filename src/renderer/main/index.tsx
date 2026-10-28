import '../shared/styles/tokens.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'
import { ChatPanel } from './features/chat/ChatPanel'
import { TasksPanel } from './features/tasks/TasksPanel'
import { CalendarPanel } from './features/calendar/CalendarPanel'
import { PointsPanel } from './features/points/PointsPanel'
import { AppHeader } from './components/AppHeader'

/**
 * 类型探针：`@shared` 别名 + 领域类型在渲染进程必须可用。
 * 后续业务代码直接 `import { Task } from '@shared/types/domain'`，不需要改别名配置。
 */
export type DomainTask = Task

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// 主窗布局（04 §2）：顶栏 56px + 下面两栏（左会话区弹性 + 右栏 400px）。
// 右栏四区块：①「当前任务」（W5）、②「日历」（W6B）、③④「积分 / 明细」（W6）。
// 外层 flex 列容器与 app-shell 的 flex:1 是 W9 挂顶栏时唯一的布局改动；
// `.app-shell` 自己的样式（features/tasks/tasks.css）零改动，靠行内 flex 覆盖它的 height:100%。
createRoot(container).render(
  <StrictMode>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppHeader />
      <div className="app-shell" style={{ flex: '1 1 auto', minHeight: 0, height: 'auto' }}>
        <ChatPanel />
        <aside className="right-col">
          <TasksPanel />
          <CalendarPanel />
          <PointsPanel />
        </aside>
      </div>
    </div>
  </StrictMode>
)

console.log(`[renderer:main] RUBRIC_VERSION=${RUBRIC_VERSION}`)
