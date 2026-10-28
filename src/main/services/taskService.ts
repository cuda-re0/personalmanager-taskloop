import type {
  Difficulty,
  Evidence,
  NotifyChannel,
  Priority,
  Task,
  TaskPatch,
  TaskStatus,
  TaskType
} from '../../shared/types/domain'
import { computePlannedPoints } from '../../shared/points/rubric'
import { isDifficultyAllowed } from '../../shared/taskRules'
import { tx } from '../db/connection'
import { appError } from '../db/errors'
import { isoToLocalDay, nowIso } from '../db/localDay'
import { newId } from '../db/ids'
import type { SqlValue } from '../db/mappers'
import * as statsRepo from '../db/repositories/statsRepo'
import * as taskRepo from '../db/repositories/taskRepo'
import { assertTransition } from '../db/stateMachine'
import { pointsConfig } from './pointsService'

/**
 * taskService —— **只做数据访问**（01 开工词 §3：不写业务编排）。
 *
 * 边界说明（避免和后续波次重复实现）：
 * - 这里不含积分计算、不含证据闸门、不含 AI 调用。`task.complete` 的完整事务（写 ledger +
 *   改 task + upsert daily_stats）属于 W6，本文件只提供零件。
 * - `tasks_created` 由本文件的 `createTask()` 负责（01 §2.6 把这张表的分工按模块划开），
 *   W6 别再累加一次。
 * - `transitionTask()` 只是状态机 + 时间戳，**不**累加 `tasks_done`（完成计数合并进 W6 的完成事务）。
 */

export interface CreateTaskInput {
  id?: string
  type: TaskType
  title: string
  status?: TaskStatus
  detailMd?: string
  parentId?: string | null
  priority?: Priority
  difficulty?: Difficulty
  estimateMin?: number | null
  dueAt?: string | null
  dailyTime?: string | null
  repeatRule?: string | null
  activeFrom?: string | null
  activeTo?: string | null
  reminderOffsets?: number[]
  reminderChannels?: NotifyChannel[]
  tags?: string[]
  pointsPlanned?: number
  requiresEvidence?: boolean
  evidence?: Evidence[]
  source?: 'chat' | 'manual' | 'hud'
  aiConfidence?: number | null
  aiProposal?: unknown
  sortKey?: number
}

/** 01 §2.1.2 的默认提醒偏移 */
const DEFAULT_OFFSETS: Record<TaskType, number[]> = {
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440],
  daily: []
}

function assertTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) throw appError('INVALID_INPUT', '任务标题不能为空')
  if (trimmed.length > 40) {
    throw appError('INVALID_INPUT', '任务标题最多 40 个字', { detail: `实际 ${trimmed.length} 字` })
  }
  return trimmed
}

export function createTask(input: CreateTaskInput): Task {
  const title = assertTitle(input.title)
  const now = nowIso()
  const id = input.id ?? newId()

  // daily 不使用 due_at / reminder_offsets（01 §2.1.1、§2.1.2），传进来了就按类型归一，不留脏数据
  const isDaily = input.type === 'daily'
  const offsets = isDaily
    ? []
    : (input.reminderOffsets ?? DEFAULT_OFFSETS[input.type] ?? [])

  // 默认难度是 medium，不是 DDL 里的 'easy'：01 §2.1 的 DEFAULT 'easy' 只是 SQL 兜底，
  // 应用层默认档由 02 §5.2b 定。easy 对 event 非法（ALLOWED_DIFFICULTIES.event 从 medium 起），
  // 用 'easy' 当默认会落一条 10 分的 event 任务，而 04 §3.2 的下拉里根本没有这一项。
  const difficulty = input.difficulty ?? 'medium'

  // 主进程只拒绝、不归位：归位（snapDifficulty）是渲染层的事（02 §5.2b）。
  // 这里悄悄换档会让卡面与库里两套口径，所以非法组合一律报错。
  if (!isDifficultyAllowed(input.type, difficulty)) {
    throw appError('INVALID_INPUT', '该任务类型不支持所选难度', {
      detail: `${input.type} + ${difficulty}`
    })
  }

  // 显式给了就必须合法：planned=0 会让 clamp(hi=0 < lo=1) 恒返回 0，做完永远 0 分（02 §5.2）
  if (input.pointsPlanned !== undefined && !(input.pointsPlanned >= 1)) {
    throw appError('INVALID_INPUT', '应得分必须 ≥ 1', { detail: `收到 ${input.pointsPlanned}` })
  }

  return tx(() => {
    // 没给 pointsPlanned 时按 type 分派现算，**不能**用 0 兜底：
    // createManual 的 TaskPatch 没有这个字段，0 兜底等于每个手建任务都是 0 分（契约 v0.10 P1-1）。
    const cfg = pointsConfig()
    const pointsPlanned =
      input.pointsPlanned ?? (isDaily ? cfg.dailyBase : computePlannedPoints(difficulty, cfg))

    const task = taskRepo.insert({
      id,
      type: input.type,
      status: input.status ?? 'todo',
      title,
      detailMd: input.detailMd ?? '',
      parentId: input.parentId ?? null,
      sortKey: input.sortKey ?? taskRepo.nextSortKey(input.parentId ?? null),
      priority: input.priority ?? 0,
      difficulty,
      estimateMin: input.estimateMin ?? null,
      dueAt: isDaily ? null : (input.dueAt ?? null),
      dailyTime: input.dailyTime ?? null,
      repeatRule: input.repeatRule ?? null,
      activeFrom: input.activeFrom ?? null,
      activeTo: input.activeTo ?? null,
      reminderOffsets: offsets,
      reminderChannels: input.reminderChannels ?? ['inapp'],
      tags: input.tags ?? [],
      pointsPlanned,
      requiresEvidence: input.requiresEvidence ?? false,
      evidence: input.evidence ?? [],
      source: input.source ?? 'chat',
      aiConfidence: input.aiConfidence ?? null,
      aiProposal: input.aiProposal,
      createdAt: now,
      updatedAt: now
    })
    statsRepo.bumpTasksCreated(isoToLocalDay(now))
    return task
  })
}

export function getTask(id: string): Task | null {
  return taskRepo.getById(id)
}

export function requireTask(id: string): Task {
  return taskRepo.requireById(id)
}

/** `task.get` 的形状：本体 + 子步骤 */
export function getTaskWithSubtasks(id: string): Task & { subtasks: Task[] } {
  const task = taskRepo.requireById(id)
  return { ...task, subtasks: taskRepo.listSubtasks(id) }
}

export interface ListTasksInput {
  status?: TaskStatus[]
  includeSubtasks?: boolean
  types?: TaskType[]
  parentId?: string | null
  limit?: number
}

export function listTasks(input: ListTasksInput = {}): Task[] {
  return taskRepo.list(input)
}

/**
 * 改任务。`patch.difficulty` 会连带重算 `points_planned`（02 §5.2b）：
 * 难度从 hard(35) 改成 easy(10) 之后应得分必须同步，否则完成时按旧值 35 发分。
 * 两次写入在同一事务里，中间失败不会留下"难度改了、分值没改"的行。
 *
 * `TaskPatch` 没有 `pointsPlanned` 也不该加——应得分是派生值，唯一来源是 difficulty × type。
 */
export function updateTask(id: string, patch: TaskPatch): Task {
  if (patch.title !== undefined) assertTitle(patch.title)
  const now = nowIso()

  return tx(() => {
    const current = taskRepo.requireById(id)
    if (patch.difficulty === undefined) return taskRepo.update(id, patch, now)

    // 同一处做 type × difficulty 校验，规则同 createTask（主进程只拒绝，不归位）
    const difficulty = patch.difficulty
    if (!isDifficultyAllowed(current.type, difficulty)) {
      throw appError('INVALID_INPUT', '该任务类型不支持所选难度', {
        detail: `${current.type} + ${difficulty}`
      })
    }

    const cfg = pointsConfig()
    const pointsPlanned =
      current.type === 'daily' ? cfg.dailyBase : computePlannedPoints(difficulty, cfg)

    taskRepo.update(id, patch, now)
    return taskRepo.updateColumns(id, { points_planned: pointsPlanned }, now)
  })
}

export function setRequiresEvidence(id: string, value: boolean): Task {
  return taskRepo.setRequiresEvidence(id, value, nowIso())
}

export function addEvidence(id: string, evidence: Evidence): Task {
  if (evidence.kind === 'text' && !evidence.text?.trim()) {
    throw appError('INVALID_INPUT', '文字证据不能为空')
  }
  // attachment 证据只断言"有附件 id"；是不是图片由 Attachment.kind 决定，不看 Evidence.kind（契约 v0.8）
  if (evidence.kind === 'attachment' && !evidence.attachmentId) {
    throw appError('INVALID_INPUT', '附件证据缺少附件 id')
  }
  return taskRepo.appendEvidence(id, evidence, nowIso())
}

export function setReminderOffsets(
  id: string,
  offsets: number[],
  channels?: NotifyChannel[]
): Task {
  const patch: TaskPatch = { reminderOffsets: offsets }
  if (channels) patch.reminderChannels = channels
  return taskRepo.update(id, patch, nowIso())
}

/**
 * 状态流转：只做状态机校验 + 时间戳，不碰积分（那是 W6）。
 * 同态调用按幂等 no-op 处理，重复点按钮不会 409。
 *
 * **`to='done'` 一律拦截**：完成必须在同一个事务里写 completed_at + points_awarded +
 * point_ledger（01 §3），这里只改状态会造出"已完成但从未入账"的任务，之后还能再补一条
 * task_done，账实直接分叉。完成入口只有一个：`task.complete`（02 §3.2）。
 */
export function transitionTask(id: string, to: TaskStatus): Task {
  if (to === 'done') {
    throw appError('CONFLICT', '完成任务请走完成流程', { detail: 'use task.complete' })
  }
  return tx(() => {
    const task = taskRepo.requireById(id)
    if (task.status === to) return task
    assertTransition(task.type, task.status, to)

    const now = nowIso()
    const cols: Record<string, SqlValue> = { status: to }
    if (to === 'doing' && task.startedAt === null) cols.started_at = now
    if (to === 'archived') cols.archived_at = now
    return taskRepo.updateColumns(id, cols, now)
  })
}

/** 软删 → discarded（02 §3.2 `task.remove`） */
export function removeTask(id: string): void {
  taskRepo.softRemove(id, nowIso())
}

export function reorderTask(id: string, beforeId: string | null): void {
  taskRepo.reorder(id, beforeId, nowIso())
}
