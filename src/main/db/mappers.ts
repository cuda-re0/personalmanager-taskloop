import type {
  Alert,
  Attachment,
  ChatMode,
  DayStat,
  Difficulty,
  Evidence,
  FxRate,
  Message,
  MessageKind,
  MessageMeta,
  MessageRole,
  MessageStatus,
  NotifyChannel,
  Occurrence,
  PointEntry,
  Priority,
  Pulse,
  Quality,
  Reminder,
  ReminderLevel,
  ReviewVerdict,
  Task,
  TaskDraft,
  TaskStatus,
  TaskType
} from '../../shared/types/domain'
import { appError } from './errors'
import type { AppErrorCode } from '../../shared/types/ipc'
import type { TaskPatch } from '../../shared/types/domain'

/**
 * `snake_case`(DB) ↔ `camelCase`(领域类型) 的**唯一**映射处。
 *
 * 规矩（01 开工词 §3）：
 * - 映射只写在这个文件里，repo 里不许再手写 `row.xxx_yyy` → 字段的对应关系
 * - DB 的 `NULL` 一律映射成 `null`，**不许**变成 `undefined`（`estimateMin: null` 是"没估时"，
 *   字段缺失是另一种意思；渲染层与 IPC 都按 `null` 判空）
 * - SQLite 没有 boolean / JSON 类型：`0|1` → boolean、`TEXT` → `T[]` 的转换也都在这里
 */

export type SqlValue = string | number | bigint | null | Buffer

/* ------------------------------------------------------------------ *
 * 通用解析
 * ------------------------------------------------------------------ */

export function parseJsonColumn<T>(raw: string, column: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    // 静默返回默认值会让"配错了 webhook 却永远收不到通知也没有线索"（W1 DELTA · 4）
    throw appError('DB_ERROR', `字段 ${column} 不是合法 JSON，数据可能已损坏`, {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    })
  }
}

function parseJsonArray<T>(raw: string, column: string): T[] {
  const parsed = parseJsonColumn<unknown>(raw, column)
  if (!Array.isArray(parsed)) {
    throw appError('DB_ERROR', `字段 ${column} 应为数组`, { detail: `实际为 ${typeof parsed}` })
  }
  return parsed as T[]
}

/* ------------------------------------------------------------------ *
 * tasks
 * ------------------------------------------------------------------ */

export interface TaskRow {
  id: string
  type: string
  status: string
  title: string
  detail_md: string
  parent_id: string | null
  sort_key: number
  priority: number
  difficulty: string
  estimate_min: number | null
  due_at: string | null
  daily_time: string | null
  repeat_rule: string | null
  active_from: string | null
  active_to: string | null
  reminder_offsets_json: string
  reminder_channels_json: string
  tags_json: string
  points_planned: number
  points_awarded: number | null
  quality: string | null
  requires_evidence: number
  evidence_json: string
  streak_current: number
  streak_best: number
  source: string
  ai_confidence: number | null
  ai_proposal_json: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  archived_at: string | null
}

/** SELECT 用的显式列清单：不写 `*`，行类型才可信 */
export const TASK_COLUMNS = [
  'id',
  'type',
  'status',
  'title',
  'detail_md',
  'parent_id',
  'sort_key',
  'priority',
  'difficulty',
  'estimate_min',
  'due_at',
  'daily_time',
  'repeat_rule',
  'active_from',
  'active_to',
  'reminder_offsets_json',
  'reminder_channels_json',
  'tags_json',
  'points_planned',
  'points_awarded',
  'quality',
  'requires_evidence',
  'evidence_json',
  'streak_current',
  'streak_best',
  'source',
  'ai_confidence',
  'ai_proposal_json',
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
  'archived_at'
] as const

/** INSERT 的列顺序，`taskInsertParams()` 的返回值必须与之等长同序 */
export const TASK_INSERT_COLUMNS = [
  'id',
  'type',
  'status',
  'title',
  'detail_md',
  'parent_id',
  'sort_key',
  'priority',
  'difficulty',
  'estimate_min',
  'due_at',
  'daily_time',
  'repeat_rule',
  'active_from',
  'active_to',
  'reminder_offsets_json',
  'reminder_channels_json',
  'tags_json',
  'points_planned',
  'requires_evidence',
  'evidence_json',
  'source',
  'ai_confidence',
  'ai_proposal_json',
  'created_at',
  'updated_at',
  'started_at'
] as const

export interface TaskInsert {
  id: string
  type: TaskType
  status: TaskStatus
  title: string
  detailMd?: string
  parentId?: string | null
  sortKey?: number
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
  createdAt: string
  updatedAt: string
  startedAt?: string | null
}

export function taskInsertParams(t: TaskInsert): SqlValue[] {
  return [
    t.id,
    t.type,
    t.status,
    t.title,
    t.detailMd ?? '',
    t.parentId ?? null,
    t.sortKey ?? 0,
    t.priority ?? 0,
    t.difficulty ?? 'easy',
    t.estimateMin ?? null,
    t.dueAt ?? null,
    t.dailyTime ?? null,
    t.repeatRule ?? null,
    t.activeFrom ?? null,
    t.activeTo ?? null,
    JSON.stringify(t.reminderOffsets ?? []),
    JSON.stringify(t.reminderChannels ?? ['inapp']),
    JSON.stringify(t.tags ?? []),
    t.pointsPlanned ?? 0,
    t.requiresEvidence === true ? 1 : 0,
    JSON.stringify(t.evidence ?? []),
    t.source ?? 'chat',
    t.aiConfidence ?? null,
    t.aiProposal === undefined ? null : JSON.stringify(t.aiProposal),
    t.createdAt,
    t.updatedAt,
    t.startedAt ?? null
  ]
}

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    title: row.title,
    detailMd: row.detail_md,
    parentId: row.parent_id,
    sortKey: row.sort_key,
    priority: row.priority as Priority,
    difficulty: row.difficulty as Difficulty,
    estimateMin: row.estimate_min,
    dueAt: row.due_at,
    dailyTime: row.daily_time,
    repeatRule: row.repeat_rule,
    activeFrom: row.active_from,
    activeTo: row.active_to,
    reminderOffsets: parseJsonArray<number>(row.reminder_offsets_json, 'tasks.reminder_offsets_json'),
    reminderChannels: parseJsonArray<NotifyChannel>(
      row.reminder_channels_json,
      'tasks.reminder_channels_json'
    ),
    tags: parseJsonArray<string>(row.tags_json, 'tasks.tags_json'),
    pointsPlanned: row.points_planned,
    pointsAwarded: row.points_awarded,
    quality: (row.quality as Quality | null) ?? null,
    requiresEvidence: row.requires_evidence === 1,
    evidence: parseJsonArray<Evidence>(row.evidence_json, 'tasks.evidence_json'),
    streakCurrent: row.streak_current,
    streakBest: row.streak_best,
    source: row.source as Task['source'],
    aiConfidence: row.ai_confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at
  }
}

/**
 * `TaskPatch` → 列名/值。PATCH 语义：只有 `!== undefined` 的键才进 SET。
 * 注意 `null` 是有效值（清空 due_at 等），不能和 `undefined` 混为一谈。
 */
export function taskPatchToColumns(patch: TaskPatch): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {}
  if (patch.title !== undefined) out.title = patch.title
  if (patch.detailMd !== undefined) out.detail_md = patch.detailMd
  if (patch.priority !== undefined) out.priority = patch.priority
  if (patch.difficulty !== undefined) out.difficulty = patch.difficulty
  if (patch.estimateMin !== undefined) out.estimate_min = patch.estimateMin
  if (patch.dueAt !== undefined) out.due_at = patch.dueAt
  if (patch.dailyTime !== undefined) out.daily_time = patch.dailyTime
  if (patch.repeatRule !== undefined) out.repeat_rule = patch.repeatRule
  if (patch.activeFrom !== undefined) out.active_from = patch.activeFrom
  if (patch.activeTo !== undefined) out.active_to = patch.activeTo
  if (patch.reminderOffsets !== undefined) out.reminder_offsets_json = JSON.stringify(patch.reminderOffsets)
  if (patch.reminderChannels !== undefined) {
    out.reminder_channels_json = JSON.stringify(patch.reminderChannels)
  }
  if (patch.requiresEvidence !== undefined) out.requires_evidence = patch.requiresEvidence ? 1 : 0
  if (patch.tags !== undefined) out.tags_json = JSON.stringify(patch.tags)
  return out
}

/* ------------------------------------------------------------------ *
 * task_occurrences
 * ------------------------------------------------------------------ */

export interface OccurrenceRow {
  id: string
  task_id: string
  day: string
  status: string
  points_awarded: number | null
  completed_at: string | null
  note: string | null
  created_at: string
  updated_at: string
  task_title?: string | null
  task_type?: string | null
}

export const OCCURRENCE_COLUMNS = [
  'id',
  'task_id',
  'day',
  'status',
  'points_awarded',
  'completed_at',
  'note',
  'created_at',
  'updated_at'
] as const

/** 联表查询用的列清单（多带 task_title / task_type，省掉渲染层的二次查询） */
export const OCCURRENCE_COLUMNS_JOINED = [
  ...OCCURRENCE_COLUMNS.map(c => `o.${c}`),
  't.title AS task_title',
  't.type AS task_type'
] as const

export function mapOccurrence(row: OccurrenceRow): Occurrence {
  const out: Occurrence = {
    id: row.id,
    taskId: row.task_id,
    day: row.day,
    status: row.status as Occurrence['status'],
    pointsAwarded: row.points_awarded,
    completedAt: row.completed_at,
    note: row.note
  }
  // 可选字段：!== null/undefined 时才带上，避免给 Map 型消费者塞一堆 undefined
  if (row.task_title !== undefined && row.task_title !== null) out.taskTitle = row.task_title
  if (row.task_type !== undefined && row.task_type !== null) out.taskType = row.task_type as TaskType
  return out
}

/* ------------------------------------------------------------------ *
 * point_ledger
 * ------------------------------------------------------------------ */

export interface PointEntryRow {
  id: string
  task_id: string | null
  occurrence_id: string | null
  delta: number
  kind: string
  reason_code: string
  reason_text: string
  day: string
  created_at: string
  /** 被冲销的时刻（002 迁移）。NULL = 这条发分仍然有效 */
  reversed_at: string | null
  /** v0.45：仅 kind='spend' 的行有值 */
  amount_cents: number | null
  /** v0.45：仅 kind='spend' 的行有值，记账当时的汇率快照 */
  fx_rate: number | null
}

export const LEDGER_COLUMNS = [
  'id',
  'task_id',
  'occurrence_id',
  'delta',
  'kind',
  'reason_code',
  'reason_text',
  'day',
  'created_at',
  'reversed_at',
  'amount_cents',
  'fx_rate'
] as const

export interface PointEntryInsert {
  id: string
  taskId: string | null
  occurrenceId: string | null
  delta: number
  kind: PointEntry['kind']
  reasonCode: PointEntry['reasonCode']
  reasonText?: string
  day: string
  createdAt: string
  /** 新写入的流水一律有效（NULL）；只有冲销时由 markReversed 事后补时间戳 */
  reversedAt?: string | null
  /** v0.45：仅支出行填，其它行省略即 NULL */
  amountCents?: number | null
  fxRate?: number | null
}

export function ledgerInsertParams(e: PointEntryInsert): SqlValue[] {
  return [
    e.id,
    e.taskId,
    e.occurrenceId,
    e.delta,
    e.kind,
    e.reasonCode,
    e.reasonText ?? '',
    e.day,
    e.createdAt,
    e.reversedAt ?? null,
    e.amountCents ?? null,
    e.fxRate ?? null
  ]
}

export function mapPointEntry(row: PointEntryRow): PointEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    occurrenceId: row.occurrence_id,
    delta: row.delta,
    kind: row.kind as PointEntry['kind'],
    reasonCode: row.reason_code as PointEntry['reasonCode'],
    reasonText: row.reason_text,
    day: row.day,
    createdAt: row.created_at,
    reversedAt: row.reversed_at,
    amountCents: row.amount_cents,
    fxRate: row.fx_rate
  }
}

/* ------------------------------------------------------------------ *
 * fx_rates（v0.45）
 * ------------------------------------------------------------------ */

export interface FxRateRow {
  id: string
  week_start: string
  rate: number
  basis: string
  source: string
  created_at: string
}

export const FX_RATE_COLUMNS = [
  'id',
  'week_start',
  'rate',
  'basis',
  'source',
  'created_at'
] as const

export interface FxRateInsert {
  id: string
  weekStart: string
  rate: number
  /** AI 的评估依据；fallback 写空串 */
  basis?: string
  source: FxRate['source']
  createdAt: string
}

export function fxRateInsertParams(r: FxRateInsert): SqlValue[] {
  return [r.id, r.weekStart, r.rate, r.basis ?? '', r.source, r.createdAt]
}

/** `basis` 不进领域类型：渲染层不需要看评估依据（45 §4.2） */
export function mapFxRate(row: FxRateRow): FxRate {
  return {
    weekStart: row.week_start,
    rate: row.rate,
    source: row.source as FxRate['source'],
    createdAt: row.created_at
  }
}

/* ------------------------------------------------------------------ *
 * reminders
 * ------------------------------------------------------------------ */

export interface ReminderRow {
  id: string
  task_id: string | null
  occurrence_id: string | null
  offset_min: number | null
  fire_at: string
  repeat_rule: string | null
  channels_json: string
  level: string
  status: string
  last_fired_at: string | null
  fired_channels_json: string
  fail_reason: string | null
  created_at: string
}

export const REMINDER_COLUMNS = [
  'id',
  'task_id',
  'occurrence_id',
  'offset_min',
  'fire_at',
  'repeat_rule',
  'channels_json',
  'level',
  'status',
  'last_fired_at',
  'fired_channels_json',
  'fail_reason',
  'created_at'
] as const

export interface ReminderInsert {
  id: string
  taskId: string | null
  occurrenceId: string | null
  offsetMin: number | null
  fireAt: string
  repeatRule?: string | null
  channels: NotifyChannel[]
  level?: ReminderLevel
  status?: Reminder['status']
  createdAt: string
}

export function reminderInsertParams(r: ReminderInsert): SqlValue[] {
  return [
    r.id,
    r.taskId,
    r.occurrenceId,
    r.offsetMin,
    r.fireAt,
    r.repeatRule ?? null,
    JSON.stringify(r.channels),
    r.level ?? 'normal',
    r.status ?? 'active',
    null,
    '[]',
    null,
    r.createdAt
  ]
}

export function mapReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    taskId: row.task_id,
    occurrenceId: row.occurrence_id,
    offsetMin: row.offset_min,
    fireAt: row.fire_at,
    repeatRule: row.repeat_rule,
    channels: parseJsonArray<NotifyChannel>(row.channels_json, 'reminders.channels_json'),
    level: row.level as ReminderLevel,
    status: row.status as Reminder['status'],
    lastFiredAt: row.last_fired_at,
    firedChannels: parseJsonArray<NotifyChannel>(
      row.fired_channels_json,
      'reminders.fired_channels_json'
    ),
    failReason: row.fail_reason,
    createdAt: row.created_at
  }
}

/* ------------------------------------------------------------------ *
 * daily_stats
 * ------------------------------------------------------------------ */

export interface DayStatRow {
  day: string
  points: number
  tasks_done: number
  tasks_created: number
  occurrences_done: number
}

export const DAY_STAT_COLUMNS = [
  'day',
  'points',
  'tasks_done',
  'tasks_created',
  'occurrences_done'
] as const

export function mapDayStat(row: DayStatRow): DayStat {
  return {
    day: row.day,
    points: row.points,
    tasksDone: row.tasks_done,
    tasksCreated: row.tasks_created,
    occurrencesDone: row.occurrences_done
  }
}

export function emptyDayStat(day: string): DayStat {
  return { day, points: 0, tasksDone: 0, tasksCreated: 0, occurrencesDone: 0 }
}

/* ------------------------------------------------------------------ *
 * messages / attachments
 * ------------------------------------------------------------------ */

export interface MessageRow {
  id: string
  thread_id: string
  role: string
  kind: string
  content_md: string
  meta_json: string
  linked_task_id: string | null
  status: string
  /** v0.73：006 迁移加的列。老行为 NULL */
  mode: string | null
  tokens_in: number | null
  tokens_out: number | null
  latency_ms: number | null
  created_at: string
}

export const MESSAGE_COLUMNS = [
  'id',
  'thread_id',
  'role',
  'kind',
  'content_md',
  'meta_json',
  'linked_task_id',
  'status',
  'mode',
  'tokens_in',
  'tokens_out',
  'latency_ms',
  'created_at'
] as const

export interface AttachmentRow {
  id: string
  message_id: string | null
  task_id: string | null
  kind: string
  /** v0.49：显示名（005 迁移）。老行为空串 */
  name: string
  rel_path: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  sha256: string
  created_at: string
}

export const ATTACHMENT_COLUMNS = [
  'id',
  'message_id',
  'task_id',
  'kind',
  'rel_path',
  'mime',
  'bytes',
  'width',
  'height',
  'sha256',
  'created_at',
  'name'
] as const

/** `Attachment.url` 由主进程拼成自定义协议（02 §2）；DB 只存 rel_path */
export function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    kind: row.kind as Attachment['kind'],
    name: row.name,
    url: `app://attach/${row.id}`,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height
  }
}

/**
 * `messages.kind` + `meta_json` → `MessageMeta` 判别联合。
 * `kind='text'` 的 meta 是 `{ kind: 'none' }`（DB 里存的是 `{}`），所以按 kind 收窄而不是照抄 JSON。
 */
export function mapMessageMeta(kind: MessageKind, raw: string): MessageMeta {
  const parsed = parseJsonColumn<Record<string, unknown>>(raw, 'messages.meta_json')
  switch (kind) {
    case 'task_draft': {
      const drafts = parsed.drafts
      return { kind: 'task_draft', drafts: Array.isArray(drafts) ? (drafts as TaskDraft[]) : [] }
    }
    case 'task_review': {
      // 缺 verdict 时不能强转：undefined 会让渲染层读 verdict.verdict 直接抛错，
      // 与 parseJsonColumn 的策略一致——坏数据报 DB_ERROR，不静默塞假 verdict（契约 v0.10 P2-6）
      const verdict = parsed.verdict
      if (!verdict || typeof verdict !== 'object') {
        throw appError('DB_ERROR', '字段 messages.meta_json 的 task_review 缺少 verdict', {
          detail: `实际为 ${verdict === null ? 'null' : typeof verdict}`
        })
      }
      return {
        kind: 'task_review',
        taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
        verdict: verdict as ReviewVerdict
      }
    }
    case 'reminder':
      return {
        kind: 'reminder',
        reminderId: typeof parsed.reminderId === 'string' ? parsed.reminderId : '',
        taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        fireAt: typeof parsed.fireAt === 'string' ? parsed.fireAt : '',
        // 写入方从 reminders.offset_min 抄进 meta_json；缺失即视为绝对时间（如每日任务按 dailyTime 触发），
        // 不拿 fireAt - dueAt 现算——那会因为 due_at 改过而算错。
        offsetMin: typeof parsed.offsetMin === 'number' ? parsed.offsetMin : null
      }
    case 'error':
      return {
        kind: 'error',
        code: (parsed.code as AppErrorCode | undefined) ?? 'UNKNOWN',
        message: typeof parsed.message === 'string' ? parsed.message : '',
        retryable: parsed.retryable === true
      }
    default:
      return { kind: 'none' }
  }
}

export function mapMessage(row: MessageRow, attachments: Attachment[]): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as MessageRole,
    kind: row.kind as MessageKind,
    contentMd: row.content_md,
    meta: mapMessageMeta(row.kind as MessageKind, row.meta_json),
    linkedTaskId: row.linked_task_id,
    status: row.status as MessageStatus,
    // 库里若有脏值就当 null（走轮推断兜底），不用 `as ChatMode` 硬转
    mode: row.mode === 'chat' || row.mode === 'task' ? row.mode : null,
    attachments,
    createdAt: row.created_at
  }
}

export interface MessageInsert {
  id: string
  threadId?: string
  role: MessageRole
  kind: MessageKind
  contentMd?: string
  meta?: MessageMeta
  linkedTaskId?: string | null
  status?: MessageStatus
  /** v0.73：发送模式；省略即 NULL（老语义），旧调用点不用改也没错 */
  mode?: ChatMode | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
  createdAt: string
}

export function messageInsertParams(m: MessageInsert): SqlValue[] {
  return [
    m.id,
    m.threadId ?? 'main',
    m.role,
    m.kind,
    m.contentMd ?? '',
    JSON.stringify(m.meta ?? { kind: 'none' }),
    m.linkedTaskId ?? null,
    m.status ?? 'sent',
    m.mode ?? null,
    m.tokensIn ?? null,
    m.tokensOut ?? null,
    m.latencyMs ?? null,
    m.createdAt
  ]
}

/* ------------------------------------------------------------------ *
 * pulses（v0.86）
 * ------------------------------------------------------------------ */

export interface PulseRow {
  id: string
  title: string
  interval_minutes: number
  window_start: string | null
  window_end: string | null
  enabled: number
  last_fired_at: string | null
  created_at: string
  updated_at: string
}

/** SELECT 用的显式列清单，也是 INSERT 的列顺序（与 pulseRepo.insert 的入参等长同序） */
export const PULSE_COLUMNS = [
  'id',
  'title',
  'interval_minutes',
  'window_start',
  'window_end',
  'enabled',
  'last_fired_at',
  'created_at',
  'updated_at'
] as const

export function mapPulse(row: PulseRow): Pulse {
  return {
    id: row.id,
    title: row.title,
    intervalMinutes: row.interval_minutes,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface AlertRow {
  id: string
  kind: string
  level: string
  source_id: string
  title: string
  fired_at: string
  acked_at: string | null
  escalated_at: string | null
}

/** SELECT 用的显式列清单，也是 INSERT 的列顺序（与 alertRepo.insert 的入参等长同序） */
export const ALERT_COLUMNS = [
  'id',
  'kind',
  'level',
  'source_id',
  'title',
  'fired_at',
  'acked_at',
  'escalated_at'
] as const

/**
 * `kind` / `level` 在库里是裸 TEXT：本单只写 `reminder` 与 normal|strong，
 * 类型层照实收窄，不为了省一次断言把 union 放宽成 string。
 */
export function mapAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    kind: row.kind as Alert['kind'],
    level: row.level as Alert['level'],
    sourceId: row.source_id,
    title: row.title,
    firedAt: row.fired_at,
    ackedAt: row.acked_at,
    escalatedAt: row.escalated_at
  }
}
