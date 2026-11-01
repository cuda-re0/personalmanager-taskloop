import '../shared/styles/tokens.css'
import { StrictMode, type ReactElement } from 'react'
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RUBRIC_VERSION } from '@shared/points/rubric'
import type { Task } from '@shared/types/domain'
import { ChatPanel } from './features/chat/ChatPanel'
import { TasksPanel } from './features/tasks/TasksPanel'
import { CalendarPanel } from './features/calendar/CalendarPanel'
import { CalendarDayView } from './features/calendar/CalendarDayView'
import { PointsPanel } from './features/points/PointsPanel'
import { RightSplit } from './features/RightSplit'
import { SPLIT_STORAGE_KEY, parseSplit, serializeSplit } from './features/splitModel'
import { AppHeader } from './components/AppHeader'
import { SettingsDrawer } from './features/settings/SettingsDrawer'

/**
 * 类型探针：`@shared` 别名 + 领域类型在渲染进程必须可用。
 * 后续业务代码直接 `import { Task } from '@shared/types/domain'`，不需要改别名配置。
 */
export type DomainTask = Task

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

/**
 * 全局拖放兜底（v0.57）：只负责"别让浏览器把文件当成导航目标"。
 *
 * 少了这两行，把文件拖到没有接收者的地方（右栏空白、日历、任务列表）时 Chromium 会
 * 当成整页导航，Electron 里表现为整窗被 file:// 页面替换（白屏）。
 * **不处理任何上传**：组件内的 `onDrop` 先执行、自己 preventDefault 并处理文件，
 * 冒泡到这里时已经被消费。
 */
window.addEventListener('dragover', event => event.preventDefault())
window.addEventListener('drop', event => event.preventDefault())

/**
 * 主窗布局（04 §2）：顶栏 56px + 下面两栏（左会话区弹性 + 右栏 460px）。
 * 右栏四区块：①「当前任务」（W5）、②「日历」（W6B）、③④「积分 / 明细」（W6）。
 * 外层 flex 列容器与 app-shell 的 flex:1 是 W9 挂顶栏时唯一的布局改动；
 * `.app-shell` 自己的样式（features/tasks/tasks.css）零改动，靠行内 flex 覆盖它的 height:100%。
 *
 * v0.26：明细改成 ④ 面板里的第四个标签，**本文件不再有明细视图状态**。
 * v0.28：日历层替换积分区——「当前选中的日历日」提升为本文件的状态（`dayDetail`），
 * ③④ 槽位按它二选一渲染 `<PointsPanel />` 或 `<CalendarDayView />`（就地替换，不弹层）。
 * 再点同一天 = 关闭（置 null 回积分面板），点其他天 = 内容直接切换。
 * 接受的副作用（kickoff/25 写明）：积分面板被替换期间其 tab 状态重置，回来回到默认，
 * 不为此做状态提升。
 * v0.29（用户裁决）：右栏改「比例配额 + 可拖分割线」——两半 flex-basis 0、按 r / 1-r
 * 等 ratio 分配（flexGrow 行内给出），窗口高度变化时上下等比伸缩，不回到
 * 「一侧定高、另一侧吸差」。r 持久化在渲染层 localStorage（SPLIT_STORAGE_KEY），
 * 惰性初始化读一次；拖动中不落盘，pointerup 写一次。
 */
function App(): ReactElement {
  const [dayDetail, setDayDetail] = useState<string | null>(null)
  /**
   * 设置抽屉（v0.44）：**关闭即卸载**——不保住 DOM，每次打开重新拉一次数据，
   * 免得抽屉里显示的是上一次打开时的旧快照。
   */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 下半份额 r（0~1 小数）：非法存储值由 parseSplit 回落默认 0.71 */
  const [ratio, setRatio] = useState<number>(() =>
    parseSplit(window.localStorage.getItem(SPLIT_STORAGE_KEY))
  )
  /** 点日期：同日再点关闭回积分面板；点其他天切换到那天（04 §4② v0.28） */
  const toggleDay = useCallback((day: string): void => {
    setDayDetail(prev => (prev === day ? null : day))
  }, [])

  /** 拖动结束（pointerup）落盘一次，move 期间不写 localStorage */
  const commitSplit = useCallback((r: number): void => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, serializeSplit(r))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppHeader onOpenSettings={() => setSettingsOpen(true)} />
      <div className="app-shell" style={{ flex: '1 1 auto', minHeight: 0, height: 'auto' }}>
        <ChatPanel />
        <aside className="right-col">
          <div className="right-half" style={{ flexGrow: 1 - ratio }}>
            <TasksPanel />
          </div>
          <RightSplit ratio={ratio} onChange={setRatio} onCommit={commitSplit} />
          <div className="right-half" style={{ flexGrow: ratio }}>
            <CalendarPanel selectedDay={dayDetail} onSelectDay={toggleDay} />
            {dayDetail ? <CalendarDayView day={dayDetail} /> : <PointsPanel />}
          </div>
        </aside>
      </div>
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

console.log(`[renderer:main] RUBRIC_VERSION=${RUBRIC_VERSION}`)
