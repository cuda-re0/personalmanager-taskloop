import '../shared/styles/tokens.css'
import { StrictMode, useCallback, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'
import { ChatPanel } from './features/chat/ChatPanel'
import { TasksPanel } from './features/tasks/TasksPanel'
import { CalendarPanel } from './features/calendar/CalendarPanel'
import { PointsPanel } from './features/points/PointsPanel'
import { LedgerPage } from './features/points/LedgerPage'
import { emitFocusTask } from './features/tasks/focusTask'
import { AppHeader } from './components/AppHeader'

/**
 * 类型探针：`@shared` 别名 + 领域类型在渲染进程必须可用。
 * 后续业务代码直接 `import { Task } from '@shared/types/domain'`，不需要改别名配置。
 */
export type DomainTask = Task

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

/**
 * 主窗布局（04 §2）：顶栏 56px + 下面两栏（左会话区弹性 + 右栏 400px）。
 * 右栏四区块：①「当前任务」（W5）、②「日历」（W6B）、③④「积分 / 明细」（W6）。
 * 外层 flex 列容器与 app-shell 的 flex:1 是 W9 挂顶栏时唯一的布局改动；
 * `.app-shell` 自己的样式（features/tasks/tasks.css）零改动，靠行内 flex 覆盖它的 height:100%。
 *
 * v0.24：加视图状态 `workbench | ledger`（右栏 ④ 的 `›` 打开整窗明细页）。
 * 顶栏两种视图都保留——HUD 开关在那里，隐藏它等于断了一条路。
 * 状态与切换函数都在这里，靠 props 往下传（不引路由库、不用 context）。
 *
 * v0.25（更正）：明细页**覆盖**在工作台之上，工作台**始终挂载**。原来二选一渲染会卸载整个
 * 工作台——左栏输入框草稿、已附图片、发送中状态、消息滚动位置都是组件内状态，卸载即丢（P1）。
 */
type MainView = 'workbench' | 'ledger'

function App(): ReactElement {
  const [view, setView] = useState<MainView>('workbench')

  const openLedger = useCallback((): void => setView('ledger'), [])
  const backToWorkbench = useCallback((): void => setView('workbench'), [])

  /**
   * 点明细行：切回工作台 + 高亮该任务，**同一次交互里同步完成**（04 §5 的字面写法）。
   * 之所以现在能同步派发：工作台不再被卸载，右栏 ① 的 `onFocusTask` 订阅一直挂着，
   * 不存在"事件发给空 window"的窗口期（v0.24 那版被迫延后派发，v0.25 起不需要）。
   */
  const openTask = useCallback((taskId: string): void => {
    setView('workbench')
    emitFocusTask(taskId)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppHeader />
      {/* 定位容器：两层都 absolute 叠在这里，明细页盖在工作台上 */}
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        {/*
          工作台：**不在任何条件分支里**，只靠内联样式隐藏。
          不用 `hidden` 属性（`.app-shell` 的 `display: flex` 会盖掉 UA 的 `[hidden]`），
          也不用 `display: none`（滚动容器失去布局后 scrollTop 归零，消息列表会跳回顶部）。
          `visibility: hidden` 保留布局与滚动位置，同时把整棵子树移出 tab 序与命中测试。
        */}
        <div
          className="app-shell"
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            height: 'auto',
            position: 'absolute',
            inset: 0,
            visibility: view === 'ledger' ? 'hidden' : 'visible',
            pointerEvents: view === 'ledger' ? 'none' : 'auto'
          }}
        >
          <ChatPanel />
          <aside className="right-col">
            <TasksPanel />
            <CalendarPanel />
            <PointsPanel onOpenLedger={openLedger} />
          </aside>
        </div>
        {view === 'ledger' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg)'
            }}
          >
            <LedgerPage onBack={backToWorkbench} onOpenTask={openTask} />
          </div>
        ) : null}
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
