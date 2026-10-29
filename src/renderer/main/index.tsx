import '../shared/styles/tokens.css'
import { StrictMode, type ReactElement } from 'react'
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

/**
 * 主窗布局（04 §2）：顶栏 56px + 下面两栏（左会话区弹性 + 右栏 460px）。
 * 右栏四区块：①「当前任务」（W5）、②「日历」（W6B）、③④「积分 / 明细」（W6）。
 * 外层 flex 列容器与 app-shell 的 flex:1 是 W9 挂顶栏时唯一的布局改动；
 * `.app-shell` 自己的样式（features/tasks/tasks.css）零改动，靠行内 flex 覆盖它的 height:100%。
 *
 * v0.26：明细改成 ④ 面板里的第四个标签，**本文件不再有视图状态**。
 * v0.24/v0.25 那套整窗明细页、覆盖层、`visibility` 隐藏工作台的做法整体作废——
 * 左栏会话区因此永远不需要"隐藏 / 恢复"，草稿与附件不会被卸载。
 */
function App(): ReactElement {
  return (
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
  )
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

console.log(`[renderer:main] RUBRIC_VERSION=${RUBRIC_VERSION}`)
