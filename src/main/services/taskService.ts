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
import type { TaskDraft } from '../../shared/types/domain'
import { isDifficultyAllowed } from '../../shared/taskRules'
import { tx } from '../db/connection'
import { appError } from '../db/errors'
import { addDays, isValidDay, isoToLocalDay, nowIso, todayLocalDay } from '../db/localDay'
import { newId } from '../db/ids'
import * as occurrenceService from '../db/occurrenceService'
import type { SqlValue } from '../db/mappers'
import * as messageRepo from '../db/repositories/messageRepo'
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
    // 应得分来源按 type 分派，**不能**用 0 兜底：
    // createManual 的 TaskPatch 没有这个字段，0 兜底等于每个手建任务都是 0 分（契约 v0.10 P1-1）。
    // daily 的应得分只有一个来源 cfg.dailyBase（02 §5.2b）：传入值一律忽略，
    // 否则 daily 传 99 会落 99，与"每日任务每天 1 分"的语义两套口径。
    // 注意上面的 <1 入参校验仍对 daily 生效——显式给了就必须合法，忽略只针对"合法但不用"。
    const cfg = pointsConfig()
    const pointsPlanned = isDaily
      ? cfg.dailyBase
      : (input.pointsPlanned ?? computePlannedPoints(difficulty, cfg))

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

/* ------------------------------------------------------------------ *
 * 草稿 → 任务（W5，kickoff/09）
 * ------------------------------------------------------------------ */

export interface PromoteDraftInput {
  messageId: string
  localId: string
  patch?: TaskPatch
}

/**
 * 幂等标记（v0.14 补定：同一 draft 第二次 promoteDraft 返回已生成的原 Task）。
 *
 * `TaskDraft` 是冻结契约（02 §2 与 domain.ts 逐字一致），不能加字段；
 * 标记以**额外的 JSON 键**写在该 draft 对象上。`mapMessageMeta` 对 drafts 数组
 * 只做整体 cast、不重建对象，所以这些键能原样读回；渲染层的类型收窄不受影响。
 */
interface DraftPromoteMarker {
  promoted?: unknown
  promotedTaskId?: unknown
}

/** draft 上读幂等标记（运行时对象比 TaskDraft 多两个键，见上） */
function promoteMarkerOf(draft: TaskDraft): DraftPromoteMarker {
  return draft as TaskDraft & DraftPromoteMarker
}

/**
 * dueHint 的合法形状（02 §1）。V8 会把 '10-30 18:00' 静默解析成 2001-10-30（实测不报错），
 * 而 due_at 同时喂提醒、逾期判定与效率系数三条链路——不匹配一律当 null，不交给 new Date。
 */
const DUE_HINT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** 落库前把 dueHint / patch.dueAt 统一成完整 ISO8601 UTC；空值或形状非法 → null */
function toDueAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!DUE_HINT_SHAPE.test(value)) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** 'HH:mm' 形状校验；不合法 → null（不带年份的脏值不落库） */
function toDailyTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return /^\d{2}:\d{2}$/.test(value) ? value : null
}

/** 'YYYY-MM-DD' 形状校验（daily 的 active_to）；不合法 → null */
function toActiveDay(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  return isValidDay(value) ? value : null
}

/**
 * 子步骤的落库类型。
 *
 * 契约没有"子任务类型"的概念（01 §3：子步骤不单独计分），但 tasks.type 是 NOT NULL，
 * 且 `taskRepo.listDailyActive()` 按 `type='daily'` 选任务时**不过滤 parent_id**——
 * 子任务若继承 daily，会被 `occurrenceService.ensureRange` 当成独立每日任务，
 * 每个步骤都生成 occurrence，污染今日列表与 streak。
 *
 * occurrenceService / taskRepo 都不在 W5 授权内（开工词红线：不许改），所以 daily 草稿的
 * 子步骤落成 `deadline`（due_at 恒 NULL：不进日历红点、不参与逾期），难度用默认档 medium
 * （deadline 合法）。缺陷本体（listDailyActive 不排除子任务）按协作纪律 7 上报架构方。
 */
function subtaskTypeOf(type: TaskType): TaskType {
  return type === 'daily' ? 'deadline' : type
}

/**
 * `task.promoteDraft`（02 §3.2）：从 `messages.meta_json` 读指定 draft → 复用 createTask
 * 落库（status `todo`）→ draft.steps 写成子任务 → meta_json 标 promoted → 返回 Task。
 *
 * 分值口径（开工词红线 2）：
 * - 写库值默认 = 生成时算好的 `draft.pointsPlanned`（与卡面显示完全一致，02 §5.2b）；
 * - `patch.difficulty` 存在时在同一事务里按 cfg 重算（daily 恒 cfg.dailyBase，传入值忽略）；
 * - 非法 type × difficulty 只拒 `INVALID_INPUT`，主进程不归位（snapDifficulty 是渲染层的事）。
 */
export function promoteDraft(input: PromoteDraftInput): Task {
  return tx(() => {
    const message = messageRepo.requireById(input.messageId)
    if (message.meta.kind !== 'task_draft') {
      throw appError('INVALID_INPUT', '请求参数格式不正确', {
        detail: `消息 ${input.messageId} 的 meta.kind=${message.meta.kind}，不是 task_draft`
      })
    }
    const drafts = message.meta.drafts
    const index = drafts.findIndex(d => d.localId === input.localId)
    if (index === -1) {
      throw appError('INVALID_INPUT', '请求参数格式不正确', {
        detail: `消息 ${input.messageId} 里没有 localId=${input.localId} 的草稿`
      })
    }
    const draft = drafts[index]

    // 幂等（v0.14 补定，含绕过 UI 直调通道）：已晋升直接返回原 Task，不重复落库、不报错
    const marker = promoteMarkerOf(draft)
    if (marker.promoted === true && typeof marker.promotedTaskId === 'string') {
      return taskRepo.requireById(marker.promotedTaskId)
    }

    const patch = input.patch ?? {}
    const cfg = pointsConfig()
    const isDaily = draft.type === 'daily'
    const today = todayLocalDay()

    // 主进程只拒绝、不归位（02 §5.2b）
    if (patch.difficulty !== undefined && !isDifficultyAllowed(draft.type, patch.difficulty)) {
      throw appError('INVALID_INPUT', '该任务类型不支持所选难度', {
        detail: `${draft.type} + ${patch.difficulty}`
      })
    }
    const difficulty = patch.difficulty ?? draft.difficulty

    const pointsPlanned = isDaily
      ? cfg.dailyBase
      : patch.difficulty !== undefined
        ? computePlannedPoints(patch.difficulty, cfg)
        : draft.pointsPlanned

    const task = createTask({
      type: draft.type,
      title: patch.title ?? draft.title,
      detailMd: patch.detailMd ?? draft.detailMd,
      difficulty,
      estimateMin: patch.estimateMin ?? draft.estimateMin,
      // deadline/event 写 due_at；daily 不使用（01 §2.1.1）
      dueAt: isDaily ? null : toDueAt(patch.dueAt !== undefined ? patch.dueAt : draft.dueHint),
      dailyTime: isDaily
        ? toDailyTime(patch.dailyTime !== undefined ? patch.dailyTime : draft.dailyTimeHint)
        : null,
      repeatRule: isDaily ? (patch.repeatRule ?? null) : null,
      activeFrom: isDaily ? (patch.activeFrom ?? today) : null,
      activeTo: isDaily
        ? toActiveDay(patch.activeTo !== undefined ? patch.activeTo : draft.activeToHint)
        : null,
      reminderOffsets: patch.reminderOffsets ?? draft.reminderOffsets,
      tags: patch.tags ?? draft.tags,
      pointsPlanned,
      requiresEvidence: patch.requiresEvidence ?? draft.requiresEvidence,
      source: 'chat',
      aiConfidence: draft.confidence,
      status: 'todo'
    })

    // steps → 子任务（01 §3：子步骤不单独计分）。daily 草稿的子步骤不传难度，
    // 走 createTask 默认档 medium（trivial/easy 对 deadline 非法，见 subtaskTypeOf 注释）
    for (const step of draft.steps) {
      createTask({
        type: subtaskTypeOf(draft.type),
        title: step.title,
        parentId: task.id,
        ...(isDaily ? {} : { difficulty }),
        estimateMin: step.estimateMin,
        status: 'todo'
      })
    }

    // daily：立刻生成头几天的 occurrence（开工词交付 2；ensureRange 幂等、内部自带事务）
    if (isDaily) {
      occurrenceService.ensureRange(today, addDays(today, 3))
    }

    // meta_json 标 promoted + 原 Task id（幂等标记），linked_task_id 指向任务；
    // handler 层据此广播 message.patch（02 §3.8：写操作必须广播）
    const marked = drafts.map((d, i) =>
      i === index ? ({ ...d, promoted: true, promotedTaskId: task.id } as TaskDraft) : d
    )
    messageRepo.patch(input.messageId, {
      meta: { kind: 'task_draft', drafts: marked },
      linkedTaskId: task.id
    })

    return task
  })
}
