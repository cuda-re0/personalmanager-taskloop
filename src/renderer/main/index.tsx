import '../shared/styles/tokens.css'
import { StrictMode, useCallback, useEffect, useState, type ReactElement } from 'react'
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
 */
type MainView = 'workbench' | 'ledger'

function App(): ReactElement {
  const [view, setView] = useState<MainView>('workbench')
  /** 从明细页跳回工作台时要高亮的任务：先记下来，等 ① 挂载并由它自己的 effect 订阅好再派发 */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)

  const openLedger = useCallback((): void => setView('ledger'), [])
  const backToWorkbench = useCallback((): void => setView('workbench'), [])

  const openTask = useCallback((taskId: string): void => {
    setView('workbench')
    setPendingFocus(taskId)
  }, [])

  /**
   * `focus-task` 是 `window` 上的 CustomEvent，消费方（右栏 ①）在 `useEffect` 里订阅。
   * 明细页视图下 ① 是卸载状态，直接同步派发会发给"没有听众"的 window——事件丢了、高亮不出现。
   * 所以这里在**本组件的 effect** 里派发：子组件的 effect 先于父组件执行，
   * 此刻 ① 已经挂载并订阅完毕，事件必被接住，滚动与 1.2s 高亮都正常。
   */
  useEffect(() => {
    if (view !== 'workbench' || pendingFocus === null) return
    emitFocusTask(pendingFocus)
    setPendingFocus(null)
  }, [view, pendingFocus])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppHeader />
      {view === 'workbench' ? (
        <div className="app-shell" style={{ flex: '1 1 auto', minHeight: 0, height: 'auto' }}>
          <ChatPanel />
          <aside className="right-col">
            <TasksPanel />
            <CalendarPanel />
            <PointsPanel onOpenLedger={openLedger} />
          </aside>
        </div>
      ) : (
        <LedgerPage onBack={backToWorkbench} onOpenTask={openTask} />
      )}
    </div>
  )
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

console.log(`[renderer:main] RUBRIC_VERSION=${RUBRIC_VERSION}`)
