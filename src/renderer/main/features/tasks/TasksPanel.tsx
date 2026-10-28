import type { DragEvent, ReactElement } from 'react'
import { useMemo, useState } from 'react'
import type { Task } from '@shared/types/domain'
import { MarkdownText } from '../chat/MarkdownText'
import { TYPE_LABEL, reminderSummary } from '../chat/chatViewModel'
import type { DailyRow, TaskGroups } from './tasksModel'
import { groupTasks, isStepChecked, remainingLabel } from './tasksModel'
import { useTasksData } from './useTasksData'
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
  onExpand,
  onComplete
}: DailyGroupProps): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <section className="task-group">
      <h3 className="task-group-title">{TYPE_LABEL.daily}</h3>
      {rows.map(({ occurrence, task }) => (
        <div key={occurrence.id}>
          <div
            className={[
              'task-row',
              task && focusId === task.id ? 'task-row--focus' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            data-task-id={task?.id}
            onClick={() => task && onExpand(task.id)}
            role="presentation"
          >
            <button
              aria-label={occurrence.taskTitle ?? task?.title ?? ''}
              className="task-check"
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
              confirming={false}
              subtasks={subtasksByParent.get(task.id) ?? []}
              task={task}
            />
          ) : null}
        </div>
      ))}
    </section>
  )
}

interface TaskGroupProps {
  label: string
  tasks: Task[]
  expandedId: string | null
  confirmingId: string | null
  focusId: string | null
  subtasksByParent: Map<string, Task[]>
  now: Date
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
  subtasksByParent,
  now,
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
            <span className="task-remaining">{remainingLabel(task, now)}</span>
          </div>
          {expandedId === task.id ? (
            <TaskDetail
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
}

/** 就地展开的详情（04 §4①）：detail_md + 步骤勾选 + 提醒偏移 + [完成]。没有类型入口 */
function TaskDetail({ task, subtasks, confirming }: DetailProps): ReactElement {
  const { actions } = useTasksData()
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
      {task.type !== 'daily' ? (
        confirming ? (
          <div className="task-confirm-bar">
            <button
              className="btn btn--primary"
              onClick={() => actions.confirmComplete(task)}
              type="button"
            >
              完成
            </button>
            <button
              className="btn btn--faint"
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
  const { tasks, occurrences, subtasksByParent, expandedId, confirmId, focusId, actions } =
    useTasksData()
  const groups: TaskGroups = useMemo(
    () => groupTasks(tasks, occurrences),
    [tasks, occurrences]
  )
  const now = new Date()

  return (
    <div className="tasks-panel">
      <DailyGroup
        expandedId={expandedId}
        focusId={focusId}
        rows={groups.daily}
        subtasksByParent={subtasksByParent}
        onComplete={actions.completeOccurrence}
        onExpand={actions.expand}
      />
      <TaskGroup
        expandedId={expandedId}
        confirmingId={confirmId}
        focusId={focusId}
        label={TYPE_LABEL.deadline}
        now={now}
        onDropRow={actions.reorder}
        onExpand={actions.expand}
        subtasksByParent={subtasksByParent}
        tasks={groups.deadline}
      />
      <TaskGroup
        expandedId={expandedId}
        confirmingId={confirmId}
        focusId={focusId}
        label={TYPE_LABEL.event}
        now={now}
        onDropRow={actions.reorder}
        onExpand={actions.expand}
        subtasksByParent={subtasksByParent}
        tasks={groups.event}
      />
    </div>
  )
}
