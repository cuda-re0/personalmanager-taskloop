import type { DragEvent, ReactElement } from 'react'
import { useMemo, useState } from 'react'
import type { Task } from '@shared/types/domain'
import { MarkdownText } from '../chat/MarkdownText'
import { TYPE_LABEL, reminderSummary } from '../chat/chatViewModel'
import type { DailyRow, TaskGroups } from './tasksModel'
import { groupTasks, isStepChecked, remainingLabel } from './tasksModel'
import { NewTaskForm } from './NewTaskForm'
import { useTasksData } from './useTasksData'
import type { TasksActions, TasksData } from './useTasksData'
import './tasks.css'

/**
 * 右栏①「当前任务」（04 §4①）。
 * 组标题 `每日 / 限时 / 活动` 是登记过的固定标签（TYPE_LABEL），空组不显示标题；
 * 其余文字只有字段值（标题、streak 数、剩余时间、提醒偏移摘要）与已登记按钮（完成 / 继续做）。
 */

function dragIdOf(e: DragEvent): string {
  return e.dataTransfer.getData('text/plain')
}

interface DailyGroupProps {
  rows: DailyRow[]
  expandedId: string | null
  focusId: string | null
  subtasksByParent: Map<string, Task[]>
  actions: TasksActions
  onExpand(taskId: string): void
  onComplete(occurrenceId: string): void
}

/**
 * 每日组：圆形勾选框 + 标题 + 连续天数（纯数字）。
 * 勾选框 = `occurrence.complete`（每日任务不进 done，状态落在 occurrence 上，01 §3）。
 */
function DailyGroup({
  rows,
  expandedId,
  focusId,
  subtasksByParent,
  actions,
  onExpand,
  onComplete
}: DailyGroupProps): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <section className="task-group">
      <h3 className="task-group-title">{TYPE_LABEL.daily}</h3>
      {rows.map(({ occurrence, task }) => {
        const done = occurrence.status === 'done'
        return (
          <div key={occurrence.id}>
            <div
              className={[
                'task-row',
                done ? 'task-row--done' : '',
                task && focusId === task.id ? 'task-row--focus' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              data-task-id={task?.id}
              onClick={() => task && onExpand(task.id)}
              role="presentation"
            >
              {/* 已打卡（v0.27）：呈已勾状态且真的 disabled，行保留、变淡、沉底 */}
              <button
                aria-label={occurrence.taskTitle ?? task?.title ?? ''}
                className={done ? 'task-check task-check--on' : 'task-check'}
                disabled={done}
                onClick={event => {
                  event.stopPropagation()
                  onComplete(occurrence.id)
                }}
                type="button"
              />
              <span className="task-title">{occurrence.taskTitle ?? task?.title ?? ''}</span>
              <span className="task-streak">{task?.streakCurrent ?? 0}</span>
            </div>
            {task && expandedId === task.id ? (
              <TaskDetail
                actions={actions}
                busy={false}
                confirming={false}
                subtasks={subtasksByParent.get(task.id) ?? []}
                task={task}
              />
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

interface TaskGroupProps {
  label: string
  tasks: Task[]
  expandedId: string | null
  confirmingId: string | null
  focusId: string | null
  /** 行内失败红字（v0.24）：按 taskId 匹配，只有失败那条行才会渲染 */
  notice: TasksData['notice']
  subtasksByParent: Map<string, Task[]>
  actions: TasksActions
  now: Date
  /** 正在送审的任务 id：期间 [完成] 禁用，一次只允许一份请求 */
  reviewingIds: ReadonlySet<string>
  onExpand(taskId: string): void
  onDropRow(draggedId: string, targetId: string | null): void
}

/** 限时 / 活动组：状态点 + 标题 + 剩余时间，组内拖拽排序（task.reorder） */
function TaskGroup({
  label,
  tasks,
  expandedId,
  confirmingId,
  focusId,
  notice,
  subtasksByParent,
  actions,
  now,
  reviewingIds,
  onExpand,
  onDropRow
}: TaskGroupProps): ReactElement | null {
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  if (tasks.length === 0) return null

  const dropBefore = (targetId: string | null) => (e: DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const id = dragIdOf(e)
    setDragOverId(null)
    if (id) onDropRow(id, targetId)
  }

  return (
    <section className="task-group">
      <h3 className="task-group-title">{label}</h3>
      {tasks.map(task => (
        <div key={task.id}>
          <div
            className={[
              'task-row',
              // v0.34：missed（审核驳回且已过截止）与 done **同档**——沉底、变淡、右列留空，
              // 复用同一个类名与样式，不新增视觉、不加任何文字
              task.status === 'done' || task.status === 'missed' ? 'task-row--done' : '',
              dragOverId === task.id ? 'task-row--drop' : '',
              focusId === task.id ? 'task-row--focus' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            data-task-id={task.id}
            draggable
            onClick={() => onExpand(task.id)}
            onDragEnd={() => setDragOverId(null)}
            onDragOver={e => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOverId(task.id)
            }}
            onDrop={dropBefore(task.id)}
            role="presentation"
          >
            <span aria-hidden className={`task-dot task-dot--${task.status}`} />
            <span className="task-title">{task.title}</span>
            {/* 今日已完成 / 今日判失败（v0.27 / v0.34）：右列留空，不显示「逾期」之类的剩余时间 */}
            <span className="task-remaining">
              {task.status === 'done' || task.status === 'missed' ? '' : remainingLabel(task, now)}
            </span>
          </div>
          {/* 完成被拒（如证据不足）的就地反馈：文案 = AppError.message 原样，2.6s 自动消失 */}
          {notice !== null && notice.taskId === task.id ? (
            <div className="task-notice">{notice.message}</div>
          ) : null}
          {expandedId === task.id ? (
            <TaskDetail
              actions={actions}
              busy={reviewingIds.has(task.id)}
              confirming={confirmingId === task.id}
              subtasks={subtasksByParent.get(task.id) ?? []}
              task={task}
            />
          ) : null}
        </div>
      ))}
      {/* 组尾投放区：拖到末尾（beforeId = null） */}
      <div
        className="task-drop-tail"
        onDragOver={e => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={dropBefore(null)}
      />
    </section>
  )
}

interface DetailProps {
  task: Task
  subtasks: Task[]
  confirming: boolean
  /** 该任务正在送审/审核中（v0.34）：[完成] 与确认条按钮禁用，防止重复发请求 */
  busy: boolean
  /**
   * 必须由 `TasksPanel` 传下来，**不能**在详情里再调 `useTasksData()`：
   * 那是另一个实例，`subtasksByParent` 恒空、`confirmId` 也不是同一份状态，
   * 结果「带未勾步骤的任务点完成」会绕过确认条直接计分完成（v0.20 修）。
   */
  actions: TasksActions
}

/** 就地展开的详情（04 §4①）：detail_md + 步骤勾选 + 提醒偏移 + [完成]。没有类型入口 */
function TaskDetail({ task, subtasks, confirming, busy, actions }: DetailProps): ReactElement {
  const offsets = reminderSummary(task.type, task.dailyTime, task.reminderOffsets)
  return (
    <div className="task-detail">
      {task.detailMd ? (
        <div className="task-detail-md">
          <MarkdownText text={task.detailMd} />
        </div>
      ) : null}
      {subtasks.length > 0 ? (
        <ul className="task-steps">
          {subtasks.map(step => {
            const checked = isStepChecked(step)
            return (
              <li className="task-step" key={step.id}>
                <button
                  aria-label={step.title}
                  aria-pressed={checked}
                  className={`task-step-check ${checked ? 'task-step-check--on' : ''}`}
                  onClick={() => actions.toggleStep(step)}
                  type="button"
                />
                <span className={checked ? 'task-step-title--on' : 'task-step-title'}>
                  {step.title}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {offsets ? <div className="task-offsets">{offsets}</div> : null}
      {/* 今日已完成 / 今日判失败的任务没有 [完成] 入口（v0.27 / v0.34）：
          detail_md / 步骤 / 偏移照常展示 */}
      {task.type !== 'daily' && task.status !== 'done' && task.status !== 'missed' ? (
        confirming ? (
          <div className="task-confirm-bar">
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => actions.confirmComplete(task)}
              type="button"
            >
              完成
            </button>
            <button
              className="btn btn--faint"
              disabled={busy}
              onClick={() => actions.confirmCompleteNoPoints(task)}
              type="button"
            >
              直接标记完成（不计分）
            </button>
            <button className="btn btn--ghost" onClick={actions.cancelComplete} type="button">
              继续做
            </button>
          </div>
        ) : (
          <div className="task-detail-actions">
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => actions.completeTask(task)}
              type="button"
            >
              完成
            </button>
          </div>
        )
      ) : null}
    </div>
  )
}

/** 右栏① 外壳：三组固定顺序 每日 → 限时 → 活动（04 §4①），空组不显示标题 */
export function TasksPanel(): ReactElement {
  const {
    tasks,
    doneTasks,
    missedTasks,
    reviewingIds,
    occurrences,
    subtasksByParent,
    expandedId,
    confirmId,
    focusId,
    notice,
    actions
  } = useTasksData()
  const groups: TaskGroups = useMemo(
    // 活跃 + 今日已完成 + 今日判失败一起进模型：done / missed 沉底、变淡是模型层排好的（v0.27 / v0.34）
    () => groupTasks([...tasks, ...doneTasks, ...missedTasks], occurrences),
    [tasks, doneTasks, missedTasks, occurrences]
  )
  const now = new Date()

  return (
    <div className="tasks-panel">
      <NewTaskForm actions={actions} />
      <DailyGroup
        actions={actions}
        expandedId={expandedId}
        focusId={focusId}
        rows={groups.daily}
        subtasksByParent={subtasksByParent}
        onComplete={actions.completeOccurrence}
        onExpand={actions.expand}
      />
      <TaskGroup
        actions={actions}
        expandedId={expandedId}
        confirmingId={confirmId}
        focusId={focusId}
        label={TYPE_LABEL.deadline}
        notice={notice}
        now={now}
        onDropRow={actions.reorder}
        onExpand={actions.expand}
        reviewingIds={reviewingIds}
        subtasksByParent={subtasksByParent}
        tasks={groups.deadline}
      />
      <TaskGroup
        actions={actions}
        expandedId={expandedId}
        confirmingId={confirmId}
        focusId={focusId}
        label={TYPE_LABEL.event}
        notice={notice}
        now={now}
        onDropRow={actions.reorder}
        onExpand={actions.expand}
        reviewingIds={reviewingIds}
        subtasksByParent={subtasksByParent}
        tasks={groups.event}
      />
    </div>
  )
}
