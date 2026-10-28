import { useState, type ReactElement } from 'react'
import { ALLOWED_DIFFICULTIES } from '@shared/taskRules'
import type { Difficulty, TaskPatch, TaskType } from '@shared/types/domain'
import { DIFFICULTY_LABEL, TYPE_LABEL, TYPE_ORDER } from '../chat/chatViewModel'
import type { TasksActions } from './useTasksData'

/**
 * 右栏① 顶部的手动建任务入口（04 §4① v0.21）。
 *
 * 收起态只有一个 `+`；点开就地展开一行表单：类型 / 标题 / 难度 / 时长 / 时间。
 * 提交走 `task.createManual`，成功后收起并清空——列表刷新由 `task.created` 事件驱动，
 * 这里不做本地乐观插入。
 *
 * 文字纪律：标签只用 04 已登记的那几个（`每日/限时/活动`、`难度`、`分钟`、`丢弃`/`确认`），
 * 不写说明、不写占位旁白、不写空状态。
 */

/** 三类任务都允许 medium（taskRules），构造默认值不会越界 */
const DEFAULT_DIFFICULTY: Difficulty = 'medium'

function coerceDifficulty(type: TaskType, current: Difficulty): Difficulty {
  return ALLOWED_DIFFICULTIES[type].includes(current) ? current : DEFAULT_DIFFICULTY
}

export function NewTaskForm({ actions }: { actions: TasksActions }): ReactElement {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<TaskType>('deadline')
  const [title, setTitle] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>(DEFAULT_DIFFICULTY)
  const [estimate, setEstimate] = useState('')
  /** 限时/活动 → `datetime-local`；每日 → `time`。切类型时清空，避免两种格式串味 */
  const [when, setWhen] = useState('')

  const reset = (): void => {
    setTitle('')
    setEstimate('')
    setWhen('')
    setDifficulty(DEFAULT_DIFFICULTY)
  }

  const close = (): void => {
    reset()
    setOpen(false)
  }

  const changeType = (next: TaskType): void => {
    setType(next)
    setDifficulty(prev => coerceDifficulty(next, prev))
    setWhen('')
  }

  const canSubmit = title.trim().length > 0

  const submit = (): void => {
    if (!canSubmit) return
    const patch: TaskPatch = {
      difficulty,
      estimateMin: estimate === '' ? null : Number(estimate)
    }
    if (type === 'daily') {
      patch.dailyTime = when === '' ? null : when
    } else if (when !== '') {
      // datetime-local 是本地时间串，落库要 ISO8601 UTC（02 §1）
      patch.dueAt = new Date(when).toISOString()
    }
    void actions.createManual({ type, title: title.trim(), patch }).then(ok => {
      if (ok) close()
    })
  }

  if (!open) {
    return (
      <div className="new-task">
        <button
          aria-label="新建任务"
          className="new-task-toggle"
          onClick={() => setOpen(true)}
          type="button"
        >
          +
        </button>
      </div>
    )
  }

  return (
    <div className="new-task">
      <div className="new-task-types">
        {TYPE_ORDER.map(item => (
          <button
            aria-pressed={item === type}
            className={`new-task-type${item === type ? ' new-task-type--on' : ''}`}
            key={item}
            onClick={() => changeType(item)}
            type="button"
          >
            {TYPE_LABEL[item]}
          </button>
        ))}
      </div>

      <input
        aria-label="标题"
        className="new-task-title"
        onChange={event => setTitle(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
        value={title}
      />

      <div className="new-task-fields">
        <select
          aria-label="难度"
          className="new-task-select"
          onChange={event => setDifficulty(event.target.value as Difficulty)}
          value={difficulty}
        >
          {ALLOWED_DIFFICULTIES[type].map(item => (
            <option key={item} value={item}>
              {DIFFICULTY_LABEL[item]}
            </option>
          ))}
        </select>

        <input
          aria-label="时长"
          className="new-task-num"
          min={0}
          onChange={event => setEstimate(event.target.value)}
          step={5}
          type="number"
          value={estimate}
        />

        {type === 'daily' ? (
          <input
            aria-label="每日时刻"
            className="new-task-time"
            onChange={event => setWhen(event.target.value)}
            type="time"
            value={when}
          />
        ) : (
          <input
            aria-label="时间"
            className="new-task-time"
            onChange={event => setWhen(event.target.value)}
            type="datetime-local"
            value={when}
          />
        )}
      </div>

      <div className="new-task-actions">
        <button className="btn btn--ghost" onClick={close} type="button">
          丢弃
        </button>
        <button className="btn btn--primary" disabled={!canSubmit} onClick={submit} type="button">
          确认
        </button>
      </div>
    </div>
  )
}
