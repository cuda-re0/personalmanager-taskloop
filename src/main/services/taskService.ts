import type {
  Difficulty,
  Evidence,
  NotifyChannel,
  PointEntry,
  Priority,
  Quality,
  Task,
  TaskCreatePatch,
  TaskPatch,
  TaskStatus,
  TaskType
} from '../../shared/types/domain'
import type { CompleteTaskInput } from '../../shared/types/ipc'
import { computeAwardedPoints, computePlannedPoints } from '../../shared/points/rubric'
import type { TaskDraft } from '../../shared/types/domain'
import { isDifficultyAllowed } from '../../shared/taskRules'
import { tx } from '../db/connection'
import { appError } from '../db/errors'
import { addDays, isValidDay, isoToLocalDay, nowIso, todayLocalDay } from '../db/localDay'
import { newId } from '../db/ids'
import * as occurrenceService from '../db/occurrenceService'
import type { SqlValue } from '../db/mappers'
import * as ledgerRepo from '../db/repositories/ledgerRepo'
import * as messageRepo from '../db/repositories/messageRepo'
import * as statsRepo from '../db/repositories/statsRepo'
import * as taskRepo from '../db/repositories/taskRepo'
import { assertTransition } from '../db/stateMachine'
import {
  award as awardPoints,
  pointsConfig,
  rollback as rollbackPoints
} from './pointsService'

/**
 * taskService —— **只做数据访问与完成事务**（01 开工词 §3、02 §3.2）。
 *
 * 边界说明（避免和后续波次重复实现）：
 * - 这里不写积分公式、不调 AI。分值一律由 `rubric.ts` 算好（02 §5.2），本文件只负责
 *   「状态 + 发分 + 统计在同一事务里」与证据闸门。每日任务的计分编排在 pointsService。
 * - `tasks_created` 由本文件的 `createTask()` 负责（01 §2.6 把这张表的分工按模块划开），
 *   W6 别再累加一次。
 * - `transitionTask()` 只是状态机 + 时间戳，**不**累加 `tasks_done`（完成计数只在
 *   `completeTask` / `undoCompletion` 里增减）。
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
  patch?: TaskCreatePatch
}

/**
 * promoteDraft 的内部返回形状（**不是 IPC 形状**）。
 *
 * `created=false` 是幂等早退（同一 draft 第二次确认）：本次没有新建任何行、meta 也没写，
 * handler 据此零广播——再发 `task.created` / `occurrence.created` / `daystats.changed`
 * 会让"created"语义失真（渲染层会把原任务当成新任务插入一次）。IPC 通道返回值仍是 `Task`，
 * 由 handler 解包。
 */
export interface PromoteDraftResult {
  task: Task
  created: boolean
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
 * （deadline 合法）。v0.15 已修 listDailyActive（排除子任务），这里保留作双保险——
 * 依赖两条独立防线比依赖一条强。
 */
function subtaskTypeOf(type: TaskType): TaskType {
  return type === 'daily' ? 'deadline' : type
}

/**
 * `task.promoteDraft`（02 §3.2）：从 `messages.meta_json` 读指定 draft → 复用 createTask
 * 落库（status `todo`）→ draft.steps 写成子任务 → meta_json 标 promoted → 返回 Task。
 *
 * 落库类型（v0.15）：patch.type 存在时按新类型落库——draft 尚未落库，"落库后不可改类型"
 * 约束的是 update 链路，确认本质是创建。due 字段（due_at / daily_time / repeat_rule /
 * active_*）一律按**落库类型**映射，原类型的 hint 字段不会泄进新类型。
 *
 * 分值口径（开工词红线 2）：
 * - 落库类型是 daily：恒 cfg.dailyBase，传入值忽略（02 §5.2b）；
 * - patch.difficulty 存在：同一事务里按 cfg 重算；
 * - 类型被 patch 改过：draft.pointsPlanned 是按**原**类型口径算的（daily→deadline 时
 *   它是 dailyBase 的 1 分），不能再用，必须按落库难度重算；
 * - 其余：写库值 = 生成时算好的 `draft.pointsPlanned`（与卡面显示完全一致）；
 * - 非法 type × difficulty 只拒 `INVALID_INPUT`，主进程不归位（snapDifficulty 是渲染层的事）。
 */
export function promoteDraft(input: PromoteDraftInput): PromoteDraftResult {
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

    // 幂等（v0.14 补定，含绕过 UI 直调通道）：已晋升直接返回原 Task，不重复落库、不报错。
    // created=false 让 handler 零广播——本次没有任何写入，"created" 类事件不成立（P2）
    const marker = promoteMarkerOf(draft)
    if (marker.promoted === true && typeof marker.promotedTaskId === 'string') {
      return { task: taskRepo.requireById(marker.promotedTaskId), created: false }
    }

    const patch = input.patch ?? {}
    const cfg = pointsConfig()
    // 落库类型：patch 带了 type 就按新类型（草稿卡就地改类型的确认链路，v0.15）
    const type = patch.type ?? draft.type
    const isDaily = type === 'daily'
    const typeChanged = patch.type !== undefined && patch.type !== draft.type
    const today = todayLocalDay()

    // 主进程只拒绝、不归位（02 §5.2b）：校验对象是**落库**类型
    if (patch.difficulty !== undefined && !isDifficultyAllowed(type, patch.difficulty)) {
      throw appError('INVALID_INPUT', '该任务类型不支持所选难度', {
        detail: `${type} + ${patch.difficulty}`
      })
    }
    const difficulty = patch.difficulty ?? draft.difficulty

    const pointsPlanned = isDaily
      ? cfg.dailyBase
      : patch.difficulty !== undefined || typeChanged
        ? computePlannedPoints(difficulty, cfg)
        : draft.pointsPlanned

    const task = createTask({
      type,
      title: patch.title ?? draft.title,
      detailMd: patch.detailMd ?? draft.detailMd,
      difficulty,
      estimateMin: patch.estimateMin ?? draft.estimateMin,
      // deadline/event 写 due_at；daily 不使用（01 §2.1.1）——按落库类型映射
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
        type: subtaskTypeOf(type),
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

    return { task, created: true }
  })
}

/* ------------------------------------------------------------------ *
 * 完成与撤销（W6，02 §3.2 / 01 §3）
 * ------------------------------------------------------------------ */

export interface CompleteTaskResult {
  task: Task
  /** `noPoints:true` 时恒为 null（02 §3.2：调用方拿它判断"这次没给分"） */
  entry: PointEntry | null
}

export interface UndoCompletionResult {
  task: Task
  /** 冲销行的流水（`noPoints` 完成过的任务没有可冲销的行，返回 null） */
  entry: PointEntry | null
}

/**
 * 完成前的状态校验。
 *
 * `done → done` 在状态机里是"同态 no-op"（双击不该 409），但**完成**不能沿用这个宽容：
 * 02 §3.2 明确"重复调用应当报错而不是假装成功"，而且 `noPoints` 重复走一遍会把
 * `tasks_done` 加两次。文案取 04 §1.1 的模板「任务不能从「{状态}」直接变为「{状态}」」。
 */
function assertCompletable(task: Task): void {
  if (task.status === 'done') {
    throw appError('CONFLICT', '任务不能从「已完成」直接变为「已完成」', {
      detail: `id=${task.id} 已处于 done`
    })
  }
  // daily 与非法边（如 todo → done）都由状态机给出已登记的 CONFLICT 文案
  assertTransition(task.type, task.status, 'done')
}

/** 距截止的小时数（02 §5.2）：仅限时任务，`dueAt` 缺失或坏值按未知处理 */
function leadHoursOf(task: Task, completedAt: string): number | null {
  if (task.type !== 'deadline' || task.dueAt === null) return null
  const due = new Date(task.dueAt).getTime()
  if (Number.isNaN(due)) return null
  return (due - new Date(completedAt).getTime()) / 3600000
}

/** 逾期天数：满 24 小时算一天、向下取整（02 §5.2）。日期整除，不产出积分值 */
function overdueDaysOf(task: Task, leadHours: number | null): number {
  if (task.type !== 'deadline' || leadHours === null || leadHours >= 0) return 0
  return Math.floor(Math.abs(leadHours) / 24)
}

/**
 * `task.complete`（02 §3.2）：**唯一**写 `completed_at` + `points_awarded` + 完成流水的入口。
 *
 * 两种模式是 `CompleteTaskInput` 的可辨识联合：给了 `quality` 就是计分，`noPoints:true`
 * 就是不计分（两个都给由守卫挡在 IPC 边界，见 guards.ts）。
 */
export function completeTask(input: CompleteTaskInput): CompleteTaskResult {
  return input.noPoints === true
    ? completeWithoutPoints(input.id, input.evidence)
    : completeWithPoints(input.id, input.quality, input.evidence)
}

/** 计分完成：状态 + 发分 + 统计同事务（失败整体回滚，不留"入账了但状态没改"） */
function completeWithPoints(
  id: string,
  quality: Quality,
  evidence: Evidence[] | undefined
): CompleteTaskResult {
  const completedAt = nowIso()
  return tx(() => {
    const task = taskRepo.requireById(id)
    assertCompletable(task)

    // 证据闸门（01 §3）：任务上已存的证据也算，缺了停在原地，不靠 UI 拦
    const provided = evidence ?? []
    if (task.requiresEvidence && task.evidence.length === 0 && provided.length === 0) {
      throw appError('CONFLICT', '证据不能为空', {
        detail: 'requiresEvidence=true 且任务与入参都没有证据'
      })
    }
    for (const item of provided) addEvidence(id, item)

    // 分值只由 rubric 算：质量 × 类型系数 − 逾期扣分，leadHours 由 completed_at 与 due_at 得出
    const leadHours = leadHoursOf(task, completedAt)
    const awarded = computeAwardedPoints({
      type: task.type,
      planned: task.pointsPlanned,
      quality,
      overdueDays: overdueDaysOf(task, leadHours),
      leadHours,
      // 活动的结果档不在 CompleteTaskInput 里（契约缺口，已在交付报告登记），按"未给"处理
      result: null
    })
    const day = isoToLocalDay(completedAt)

    const updated = taskRepo.updateColumns(
      id,
      { status: 'done', completed_at: completedAt, points_awarded: awarded, quality },
      completedAt
    )
    // 唯一索引兜底：同一任务的第二条 task_done（occurrence_id IS NULL）在这里被拒并转 CONFLICT
    const entry = awardPoints({
      taskId: id,
      occurrenceId: null,
      delta: awarded,
      kind: 'award',
      reasonCode: 'task_done',
      reasonText: task.title,
      day
    })
    statsRepo.bumpTasksDone(day)
    return { task: updated, entry }
  })
}

/**
 * 不计分出口（02 §3.2 的 `noPoints:true`）：写 `completed_at` + `status='done'` + `tasks_done`，
 * **不写 ledger**、`points_awarded` 留 NULL。证据闸门对它不生效——它就是防死锁的那个口子。
 */
function completeWithoutPoints(id: string, evidence: Evidence[] | undefined): CompleteTaskResult {
  const completedAt = nowIso()
  return tx(() => {
    const task = taskRepo.requireById(id)
    assertCompletable(task)
    for (const item of evidence ?? []) addEvidence(id, item)

    const updated = taskRepo.updateColumns(
      id,
      { status: 'done', completed_at: completedAt, points_awarded: null, quality: null },
      completedAt
    )
    statsRepo.bumpTasksDone(isoToLocalDay(completedAt))
    return { task: updated, entry: null }
  })
}

/**
 * 撤销限时/活动的完成（01 §3：`done → doing` + 负流水冲销 + `completed_at` 清空）。
 *
 * 三条实现约束：
 * - 冲销走 `pointsService.rollback()`：原发分行标 `reversed_at` + 写一条负行，**不删流水**
 *   （唯一真相是 ledger）；只标时间戳不改金额，于是撤销后能重做，审计也查得出哪条被冲了（01 §2.4）；
 * - 找原发分行时要带 `reversedAt === null`——撤销后重做会留下"旧行已冲销 + 新行有效"两行，
 *   不筛就会反复冲销同一条；
 * - `tasks_done` 在**原完成日**减回来，与 `rebuildDailyStats` 的口径一致。
 *
 * 未完成的任务没有可撤销的完成记录：按 `transitionTask` 的同态 no-op 处理，不报错也不写库。
 */
export function undoCompletion(id: string): UndoCompletionResult {
  return tx(() => {
    const task = taskRepo.requireById(id)
    if (task.status !== 'done') return { task, entry: null }

    const original =
      ledgerRepo
        .listByTask(id)
        .find(
          e =>
            e.reasonCode === 'task_done' && e.occurrenceId === null && e.reversedAt === null
        ) ?? null
    // noPoints 完成的任务没有 task_done 行，撤销只回状态、不冲销
    const entry = original === null ? null : rollbackPoints(original, task.title)
    const day = task.completedAt === null ? todayLocalDay() : isoToLocalDay(task.completedAt)

    const updated = taskRepo.updateColumns(
      id,
      { status: 'doing', completed_at: null, points_awarded: null, quality: null },
      nowIso()
    )
    statsRepo.bumpTasksDone(day, -1)
    return { task: updated, entry }
  })
}
