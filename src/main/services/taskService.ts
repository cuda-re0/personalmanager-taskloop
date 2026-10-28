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
import { tx } from '../db/connection'
import { appError } from '../db/errors'
import { isoToLocalDay, nowIso } from '../db/localDay'
import { newId } from '../db/ids'
import type { SqlValue } from '../db/mappers'
import * as statsRepo from '../db/repositories/statsRepo'
import * as taskRepo from '../db/repositories/taskRepo'
import { assertTransition } from '../db/stateMachine'

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

  return tx(() => {
    const task = taskRepo.insert({
      id,
      type: input.type,
      status: input.status ?? 'todo',
      title,
      detailMd: input.detailMd ?? '',
      parentId: input.parentId ?? null,
      sortKey: input.sortKey ?? taskRepo.nextSortKey(input.parentId ?? null),
      priority: input.priority ?? 0,
      difficulty: input.difficulty ?? 'easy',
      estimateMin: input.estimateMin ?? null,
      dueAt: isDaily ? null : (input.dueAt ?? null),
      dailyTime: input.dailyTime ?? null,
      repeatRule: input.repeatRule ?? null,
      activeFrom: input.activeFrom ?? null,
      activeTo: input.activeTo ?? null,
      reminderOffsets: offsets,
      reminderChannels: input.reminderChannels ?? ['inapp'],
      tags: input.tags ?? [],
      pointsPlanned: input.pointsPlanned ?? 0,
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

export function updateTask(id: string, patch: TaskPatch): Task {
  if (patch.title !== undefined) assertTitle(patch.title)
  return taskRepo.update(id, patch, nowIso())
}

export function setRequiresEvidence(id: string, value: boolean): Task {
  return taskRepo.setRequiresEvidence(id, value, nowIso())
}

export function addEvidence(id: string, evidence: Evidence): Task {
  if (evidence.kind === 'text' && !evidence.text?.trim()) {
    throw appError('INVALID_INPUT', '文字证据不能为空')
  }
  if (evidence.kind === 'image' && !evidence.attachmentId) {
    throw appError('INVALID_INPUT', '图片证据缺少附件 id')
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
 */
export function transitionTask(id: string, to: TaskStatus): Task {
  return tx(() => {
    const task = taskRepo.requireById(id)
    if (task.status === to) return task
    assertTransition(task.type, task.status, to)

    const now = nowIso()
    const cols: Record<string, SqlValue> = { status: to }
    if (to === 'doing' && task.startedAt === null) cols.started_at = now
    if (to === 'done') cols.completed_at = now
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
