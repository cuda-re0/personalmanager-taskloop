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
 * v0.87：末尾追加一项本地 kind，选中后同一张卡就地换成 pulse 的字段，提交走
 * `pulse.create`。共享常量（`TYPE_LABEL` / `TYPE_ORDER`）是 `TaskType` 上的闭集，
 * 这里一行都不改，新增 kind 只在文件内声明。
 *
 * 文字纪律：标签只用已登记的那几个（`每日/限时/活动` + 本地那一项、`难度`、`分钟`、
 * `小时`、`丢弃`/`确认`），不写说明、不写占位旁白、不写空状态。
 */

/** 三类任务都允许 medium（taskRules），构造默认值不会越界 */
const DEFAULT_DIFFICULTY: Difficulty = 'medium'

/** 创建卡的类型域：三种任务 + pulse。共享的 `TaskType` 不含后者，也不该含 */
type FormKind = TaskType | 'pulse'

const PULSE_KIND = 'pulse'
const PULSE_LABEL = '周期提醒'

function coerceDifficulty(type: TaskType, current: Difficulty): Difficulty {
  return ALLOWED_DIFFICULTIES[type].includes(current) ? current : DEFAULT_DIFFICULTY
}

export function NewTaskForm({ actions }: { actions: TasksActions }): ReactElement {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<FormKind>('deadline')
  const [title, setTitle] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>(DEFAULT_DIFFICULTY)
  const [estimate, setEstimate] = useState('')
  /** 限时/活动 → `datetime-local`；每日 → `time`。切类型时清空，避免两种格式串味 */
  const [when, setWhen] = useState('')
  /** pulse 的四个字段（v0.87）：间隔数字 + 单位 + 可空的时段 */
  const [intervalText, setIntervalText] = useState('30')
  const [unit, setUnit] = useState<'minute' | 'hour'>('minute')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const reset = (): void => {
    setTitle('')
    setEstimate('')
    setWhen('')
    setDifficulty(DEFAULT_DIFFICULTY)
    setIntervalText('30')
    setUnit('minute')
    setStart('')
    setEnd('')
  }

  const close = (): void => {
    reset()
    setOpen(false)
  }

  const changeType = (next: FormKind): void => {
    setType(next)
    // pulse 没有难度可挑，别拿它去索引 ALLOWED_DIFFICULTIES
    if (next !== PULSE_KIND) setDifficulty(prev => coerceDifficulty(next, prev))
    setWhen('')
  }

  /** 选 `hour` 时接口收的是分钟；非整数（含空串 → 0 之外的 NaN）一律 NaN，交给 canSubmit 挡 */
  const intervalMinutes = (): number => {
    const n = Number(intervalText)
    if (!Number.isInteger(n)) return Number.NaN
    return unit === 'hour' ? n * 60 : n
  }

  /** 两个时段要么都填、要么都不填；只填一个不算可提交 */
  const windowPaired = (start === '') === (end === '')

  const canSubmit =
    type === PULSE_KIND
      ? title.trim().length > 0 &&
        Number.isInteger(intervalMinutes()) &&
        intervalMinutes() >= 1 &&
        intervalMinutes() <= 1440 &&
        windowPaired
      : title.trim().length > 0

  const submit = (): void => {
    if (!canSubmit) return
    if (type === PULSE_KIND) {
      void actions
        .createPulse({
          title: title.trim(),
          intervalMinutes: intervalMinutes(),
          windowStart: start === '' ? null : start,
          windowEnd: end === '' ? null : end
        })
        .then(ok => {
          if (ok) close()
        })
      return
    }
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
        <button
          aria-pressed={PULSE_KIND === type}
          className={`new-task-type${PULSE_KIND === type ? ' new-task-type--on' : ''}`}
          onClick={() => changeType(PULSE_KIND)}
          type="button"
        >
          {PULSE_LABEL}
        </button>
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

      {type === PULSE_KIND ? (
        <>
          <div className="new-task-fields">
            <input
              aria-label="间隔"
              className="new-task-num"
              min={1}
              onChange={event => setIntervalText(event.target.value)}
              step={1}
              type="number"
              value={intervalText}
            />

            <select
              aria-label="单位"
              className="new-task-select"
              onChange={event => setUnit(event.target.value === 'hour' ? 'hour' : 'minute')}
              value={unit}
            >
              <option value="minute">分钟</option>
              <option value="hour">小时</option>
            </select>
          </div>

          <div className="new-task-fields">
            <input
              aria-label="开始"
              className="new-task-time"
              onChange={event => setStart(event.target.value)}
              type="time"
              value={start}
            />

            <input
              aria-label="结束"
              className="new-task-time"
              onChange={event => setEnd(event.target.value)}
              type="time"
              value={end}
            />
          </div>
        </>
      ) : (
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
      )}

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
