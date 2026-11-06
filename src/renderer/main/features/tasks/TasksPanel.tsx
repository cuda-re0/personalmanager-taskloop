import type { DragEvent, FocusEvent, KeyboardEvent, MouseEvent, ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Pulse, Task } from '@shared/types/domain'
import {
  describeRepeatRule,
  parseRepeatRule,
  serializeRepeatRule,
  type RepeatRule,
  type RepeatUnit
} from '@shared/repeatRule'
import { MarkdownText } from '../chat/MarkdownText'
import { TYPE_LABEL, reminderSummary } from '../chat/chatViewModel'
import type { DailyRow, TaskGroups } from './tasksModel'
import {
  canEditDueOf,
  dueDateValueOf,
  duePatchOfParts,
  dueTimeValueOf,
  groupTasks,
  isStepChecked,
  taskRightParts
} from './tasksModel'
import { NewTaskForm } from './NewTaskForm'
import { useTasksData } from './useTasksData'
import type { TasksActions, TasksData } from './useTasksData'
import './tasks.css'

/** v0.76：每日任务重复规则编辑的四类、单位字与周几字（B8 文字白名单） */
const REPEAT_KINDS: { unit: RepeatUnit; label: string }[] = [
  { unit: 'D', label: '每天' },
  { unit: 'W', label: '每周' },
  { unit: 'M', label: '每月' },
  { unit: 'Y', label: '每年' }
]
const REPEAT_UNIT_LABEL: Record<RepeatUnit, string> = { D: '天', W: '周', M: '月', Y: '年' }
const REPEAT_WEEKDAY_LABEL = ['一', '二', '三', '四', '五', '六', '日']

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

interface RightProps {
  task: Task
  now: Date
  actions: TasksActions
}

/**
 * 行右列（v0.65）：剩余 · 目标，活动任务的日期那段是一颗按钮，点它就地把整格换成输入框。
 * v0.75：输入框是「日期 + 时间」一对，时间可留空（留空 = 仍按纯日期写回）。
 * 外壳仍是 `span.task-remaining`（类名 / 层级 / 位置不变），不新增任何可见文字。
 */
function TaskRight({ task, now, actions }: RightProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draftDate, setDraftDate] = useState('')
  const [draftTime, setDraftTime] = useState('')

  const stop = (event: MouseEvent): void => {
    event.stopPropagation()
  }

  const commit = (): void => {
    // 清空日期等于取消（这类任务没有「没有日期」的形态）
    if (draftDate === '') {
      setEditing(false)
      return
    }
    // 没改就不写库：每次失焦都发一次 update 会白白重建提醒行
    if (draftDate === dueDateValueOf(task.dueAt) && draftTime === dueTimeValueOf(task.dueAt)) {
      setEditing(false)
      return
    }
    actions.updateTask(task.id, { dueAt: duePatchOfParts(draftDate, draftTime) })
    setEditing(false)
  }

  /** 焦点还在这一对框里（用户要去改另一个框）就不提交；relatedTarget 为 null 时照常提交 */
  const onPairBlur = (event: FocusEvent<HTMLSpanElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return
    }
    commit()
  }

  const onPairKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <span className="task-remaining">
        <span className="task-due-pair" onBlur={onPairBlur} onKeyDown={onPairKeyDown}>
          <input
            aria-label="日期"
            autoFocus
            className="task-due-inline task-due-inline--date"
            draggable={false}
            type="date"
            value={draftDate}
            onChange={event => setDraftDate(event.target.value)}
            onClick={stop}
            onDragStart={event => event.preventDefault()}
            onMouseDown={stop}
          />
          <input
            aria-label="时间"
            className="task-due-inline task-due-inline--time"
            draggable={false}
            type="time"
            value={draftTime}
            onChange={event => setDraftTime(event.target.value)}
            onClick={stop}
            onDragStart={event => event.preventDefault()}
            onMouseDown={stop}
          />
        </span>
      </span>
    )
  }

  const { remaining, due } = taskRightParts(task, now)
  const editable = due !== '' && canEditDueOf(task)

  return (
    <span className="task-remaining">
      {remaining !== '' ? <span>{remaining}</span> : null}
      {remaining !== '' && due !== '' ? ' · ' : null}
      {due === '' ? null : editable ? (
        <button
          className="task-due-btn"
          onClick={event => {
            event.stopPropagation()
            setDraftDate(dueDateValueOf(task.dueAt))
            setDraftTime(dueTimeValueOf(task.dueAt))
            setEditing(true)
          }}
          type="button"
        >
          {due}
        </button>
      ) : (
        <span>{due}</span>
      )}
    </span>
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
            {/* v0.38：pending_review 复用 reviewing 的圆点样式（只是一个「在等结果」的标记，不新增视觉） */}
            <span
              aria-hidden
              className={`task-dot task-dot--${task.status === 'pending_review' ? 'reviewing' : task.status}`}
            />
            <span className="task-title">{task.title}</span>
            {/* 今日已完成 / 今日判失败（v0.27 / v0.34）：右列留空，不显示「逾期」之类的剩余时间。
                v0.59：剩余 · 目标一行；v0.65 交给 TaskRight（活动任务的日期可点改） */}
            <TaskRight actions={actions} now={now} task={task} />
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

  // v0.76：重复规则编辑态。只有 daily 会渲染与解析，其余类型不碰这些 state
  const [repeatOpen, setRepeatOpen] = useState(false)
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>('D')
  const [repeatN, setRepeatN] = useState('1')
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>([1])
  const [repeatMonthDay, setRepeatMonthDay] = useState('')
  const [repeatYearMonth, setRepeatYearMonth] = useState('')
  const [repeatYearDay, setRepeatYearDay] = useState('')
  const [repeatTime, setRepeatTime] = useState('')
  // v0.84：删除确认态（就地两态，不弹窗）
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const openRepeat = (): void => {
    const r = parseRepeatRule(task.repeatRule)
    setRepeatUnit(r.unit)
    setRepeatN(String(r.n))
    setRepeatWeekdays(r.weekdays.length > 0 ? r.weekdays : [1])
    setRepeatMonthDay(r.monthDays.length > 0 ? String(r.monthDays[0]) : '')
    setRepeatYearMonth(r.monthDay === null ? '' : String(Number(r.monthDay.slice(0, 2))))
    setRepeatYearDay(r.monthDay === null ? '' : String(Number(r.monthDay.slice(3))))
    setRepeatTime(task.dailyTime ?? '')
    setRepeatOpen(true)
  }

  /** 草稿折成规则；只填一个月 / 日字段时返回 null（非法，不提交） */
  const ruleOfDraft = (
    unit: RepeatUnit,
    nText: string,
    weekdays: number[],
    monthDayText: string,
    yearMonth: string,
    yearDay: string
  ): RepeatRule | null => {
    const base: RepeatRule = {
      n: Number(nText.trim()),
      unit,
      weekdays: [],
      monthDays: [],
      monthDay: null
    }
    if (unit === 'W') return { ...base, weekdays }
    if (unit === 'M') {
      if (monthDayText.trim() === '') return base
      return { ...base, monthDays: [Number(monthDayText.trim())] }
    }
    if (unit === 'Y') {
      const m = yearMonth.trim()
      const d = yearDay.trim()
      if (m === '' && d === '') return base
      if (m === '' || d === '') return null
      const pad = (v: string): string => (Number(v) < 10 ? `0${Number(v)}` : String(Number(v)))
      return { ...base, monthDay: `${pad(m)}-${pad(d)}` }
    }
    return base
  }

  const commitRepeat = (draft: {
    unit: RepeatUnit
    nText: string
    weekdays: number[]
    monthDayText: string
    yearMonth: string
    yearDay: string
    timeText: string
  }, closeOnSuccess: boolean): void => {
    let serialized: string
    try {
      const r = ruleOfDraft(
        draft.unit,
        draft.nText,
        draft.weekdays,
        draft.monthDayText,
        draft.yearMonth,
        draft.yearDay
      )
      if (r === null) {
        setRepeatOpen(false)
        return
      }
      serialized = serializeRepeatRule(r)
      parseRepeatRule(serialized) // n 越界 / 号 0、32 / 非法月日 → 抛错
    } catch {
      setRepeatOpen(false) // 非法值不提交，回只读，原值不变
      return
    }
    void window.api.task
      .update({
        id: task.id,
        patch: {
          repeatRule: serialized,
          // 时刻清空是合法操作：写 null，让 syncForTask 把旧时刻的提醒行全清掉
          dailyTime: draft.timeText.trim() === '' ? null : draft.timeText.trim()
        }
      })
      .then(res => {
        if (!res.ok) {
          console.error('[tasks] task.update 失败', res.error.message)
          return
        }
        if (closeOnSuccess) setRepeatOpen(false)
      })
      .catch((e: unknown) => console.error('[tasks] task.update 调用失败', e))
  }

  const commitCurrent = (): void =>
    commitRepeat({
      unit: repeatUnit,
      nText: repeatN,
      weekdays: repeatWeekdays,
      monthDayText: repeatMonthDay,
      yearMonth: repeatYearMonth,
      yearDay: repeatYearDay,
      timeText: repeatTime
    }, true)

  const onRepeatKind = (next: RepeatUnit): void => {
    setRepeatUnit(next)
    const weekdays = next === 'W' && repeatWeekdays.length === 0 ? [1] : repeatWeekdays
    if (next === 'W' && repeatWeekdays.length === 0) setRepeatWeekdays([1])
    commitRepeat({
      unit: next,
      nText: repeatN,
      weekdays,
      monthDayText: repeatMonthDay,
      yearMonth: repeatYearMonth,
      yearDay: repeatYearDay,
      timeText: repeatTime
    }, false)
  }

  const onRepeatBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return
    }
    commitCurrent()
  }

  const onRepeatKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 按钮上的 Enter 由它自己的 onClick 处理，别让冒泡再提交一次旧 unit
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) commitCurrent()
  }

  // v0.59：只有活动任务在 todo / doing 时可改日期（与 planReminders 同口径）；v0.65 口径收到任务模型里
  const canEditDue = canEditDueOf(task)
  // v0.83：库里的坏规则不能让 describeRepeatRule 抛错掀掉整棵 React 树（全仓无 ErrorBoundary）。
  // 失败时该行渲染成空的可点按钮——用户仍能点进去改成合法值，且不新增任何文案。
  let repeatLabel = ''
  try {
    repeatLabel = describeRepeatRule(task.repeatRule)
  } catch {
    repeatLabel = ''
  }
  // v0.84：重复行只留一行——规则 + 时刻；时刻为空时不加尾随空格
  const repeatText = [repeatLabel, task.dailyTime ?? ''].filter(Boolean).join(' ')
  // 可软删的来源状态，与 stateMachine 允许迁到 discarded 的口径一致
  const canDelete =
    task.status === 'todo' ||
    task.status === 'doing' ||
    task.status === 'pending_review' ||
    task.status === 'reviewing'

  const askDelete = (): void => {
    if (confirming) actions.cancelComplete()
    setDeleteConfirm(true)
  }

  const confirmDelete = (): void => {
    actions.removeTask(task.id)
    setDeleteConfirm(false)
  }
  // v0.75：日期 + 时间两个框，时间可留空；写法与行内编辑共用同一套
  const [dueDateDraft, setDueDateDraft] = useState(() => dueDateValueOf(task.dueAt))
  const [dueTimeDraft, setDueTimeDraft] = useState(() => dueTimeValueOf(task.dueAt))
  // 外部改了日期、或切到了另一个任务：草稿跟着走（否则会拿旧值把新值覆盖掉）
  useEffect(() => {
    setDueDateDraft(dueDateValueOf(task.dueAt))
    setDueTimeDraft(dueTimeValueOf(task.dueAt))
  }, [task.id, task.dueAt])

  const commitDue = (): void => {
    // 清空不提交：活动任务没有"没有日期"的形态（改回原值，等于什么都没发生）
    if (dueDateDraft === '') {
      setDueDateDraft(dueDateValueOf(task.dueAt))
      setDueTimeDraft(dueTimeValueOf(task.dueAt))
      return
    }
    // 没改就不写库：每次失焦都发一次 update 会白白重建提醒行
    if (
      dueDateDraft === dueDateValueOf(task.dueAt) &&
      dueTimeDraft === dueTimeValueOf(task.dueAt)
    ) {
      return
    }
    actions.updateTask(task.id, { dueAt: duePatchOfParts(dueDateDraft, dueTimeDraft) })
  }

  /** 容器内移动不提交：从日期框点到时间框时焦点仍在这一对框里 */
  const onEditBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return
    }
    commitDue()
  }

  const onEditKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') commitDue()
  }

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
      {task.type !== 'daily' && offsets ? <div className="task-offsets">{offsets}</div> : null}
      {task.type === 'daily' ? (
        repeatOpen ? (
          <div onBlur={onRepeatBlur} onKeyDown={onRepeatKeyDown}>
            <div className="task-repeat-kinds">
              {REPEAT_KINDS.map(kind => (
                <button
                  aria-pressed={repeatUnit === kind.unit}
                  key={kind.unit}
                  onClick={() => onRepeatKind(kind.unit)}
                  type="button"
                >
                  {kind.label}
                </button>
              ))}
            </div>
            <div className="task-repeat-every">
              <span>每</span>
              <input
                className="task-due-edit-input task-repeat-num"
                type="number"
                value={repeatN}
                onChange={event => setRepeatN(event.target.value)}
              />
              <span>{REPEAT_UNIT_LABEL[repeatUnit]}</span>
            </div>
            {repeatUnit === 'W' ? (
              <div className="task-repeat-days">
                {REPEAT_WEEKDAY_LABEL.map((label, index) => {
                  const weekday = index + 1
                  const on = repeatWeekdays.includes(weekday)
                  return (
                    <button
                      aria-pressed={on}
                      key={weekday}
                      onClick={() => {
                        if (on && repeatWeekdays.length === 1) return
                        setRepeatWeekdays(
                          on
                            ? repeatWeekdays.filter(w => w !== weekday)
                            : [...repeatWeekdays, weekday].sort((a, b) => a - b)
                        )
                      }}
                      type="button"
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {repeatUnit === 'M' ? (
              <div className="task-repeat-every">
                <input
                  className="task-due-edit-input task-repeat-num"
                  type="number"
                  value={repeatMonthDay}
                  onChange={event => setRepeatMonthDay(event.target.value)}
                />
              </div>
            ) : null}
            {repeatUnit === 'Y' ? (
              <div className="task-repeat-every">
                <input
                  className="task-due-edit-input task-repeat-num"
                  type="number"
                  value={repeatYearMonth}
                  onChange={event => setRepeatYearMonth(event.target.value)}
                />
                <span>月</span>
                <input
                  className="task-due-edit-input task-repeat-num"
                  type="number"
                  value={repeatYearDay}
                  onChange={event => setRepeatYearDay(event.target.value)}
                />
                <span>日</span>
              </div>
            ) : null}
            <div className="task-repeat-every">
              <input
                className="task-due-edit-input task-repeat-time"
                type="time"
                value={repeatTime}
                onChange={event => setRepeatTime(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="task-repeat-row">
            <span>重复</span>
            <button className="task-repeat-value" onClick={openRepeat} type="button">
              {repeatText}
            </button>
          </div>
        )
      ) : null}
      {/* v0.59：活动任务的日期时间输入（只有活动、只有 todo / doing）。不带可见标签，aria-label 不进视觉 */}
      {canEditDue ? (
        <div className="task-due-edit" onBlur={onEditBlur} onKeyDown={onEditKeyDown}>
          <input
            aria-label="日期"
            className="task-due-edit-input task-due-edit-input--date"
            type="date"
            value={dueDateDraft}
            onChange={event => setDueDateDraft(event.target.value)}
          />
          <input
            aria-label="时间"
            className="task-due-edit-input task-due-edit-input--time"
            type="time"
            value={dueTimeDraft}
            onChange={event => setDueTimeDraft(event.target.value)}
          />
        </div>
      ) : null}
      {/* 删除入口（v0.84）：与完成共用同一条 actions 区，两态互斥；
          done / missed / discarded / archived 不显示删除。
          今日已完成 / 今日判失败的任务没有 [完成] 入口（v0.27 / v0.34）；
          v0.38：pending_review（待提交）也没有——已经提交过一次，等的是交材料不是再点完成。
          detail_md / 步骤 / 偏移照常展示 */}
      {canDelete ? (
        deleteConfirm ? (
          <div className="task-confirm-bar">
            <button className="btn btn--primary" onClick={confirmDelete} type="button">
              删除
            </button>
            <button className="btn btn--ghost" onClick={() => setDeleteConfirm(false)} type="button">
              取消
            </button>
          </div>
        ) : confirming ? (
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
            {task.type !== 'daily' &&
            task.status !== 'done' &&
            task.status !== 'missed' &&
            task.status !== 'pending_review' ? (
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() => actions.completeTask(task)}
                type="button"
              >
                完成
              </button>
            ) : null}
            <button className="btn btn--ghost" onClick={askDelete} type="button">
              删除
            </button>
          </div>
        )
      ) : null}
    </div>
  )
}

interface PulseSectionProps {
  pulses: Pulse[]
  actions: TasksActions
}

/**
 * 高频 pulse 列表（v0.86 / v0.87）：列表只读展示，新增入口在创建卡里。
 * 分组结构与「每日 / 限时 / 活动」同构（`task-group` + `task-group-title`），
 * 没有条目时整块不渲染（不写空状态文案）。
 */
function PulseSection({ pulses, actions }: PulseSectionProps): ReactElement | null {
  const intervalLabel = (minutes: number): string =>
    minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`

  const windowLabel = (item: Pulse): string =>
    item.windowStart !== null &&
    item.windowEnd !== null &&
    item.windowStart !== '' &&
    item.windowEnd !== ''
      ? `${item.windowStart}–${item.windowEnd}`
      : ''

  if (pulses.length === 0) return null

  return (
    <section className="task-group">
      <h3 className="task-group-title">周期提醒</h3>
      {pulses.map(item => {
        const win = windowLabel(item)
        return (
          <div className="pulse-row" key={item.id}>
            <span className="task-title">{item.title}</span>
            <span className="pulse-meta">{intervalLabel(item.intervalMinutes)}</span>
            {win === '' ? null : <span className="pulse-meta">{win}</span>}
            <button
              className="pulse-btn"
              onClick={() => actions.setPulseEnabled({ id: item.id, enabled: !item.enabled })}
              type="button"
            >
              {item.enabled ? '暂停' : '启用'}
            </button>
            <button className="pulse-btn" onClick={() => actions.removePulse(item.id)} type="button">
              删除
            </button>
          </div>
        )
      })}
    </section>
  )
}

/** 右栏① 外壳：三组固定顺序 每日 → 限时 → 活动（04 §4①），空组不显示标题 */
export function TasksPanel(): ReactElement {
  const {
    tasks,
    pulses,
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
      <PulseSection actions={actions} pulses={pulses} />
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
