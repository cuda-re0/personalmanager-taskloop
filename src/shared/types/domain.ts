import type { AppErrorCode } from './ipc'

export type TaskType = 'daily' | 'deadline' | 'event'
export type TaskStatus = 'todo' | 'doing' | 'reviewing' | 'done' | 'discarded' | 'archived'
export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard' | 'epic'
export type Quality = 'partial' | 'met' | 'exceeded'
/**
 * 活动任务的结果档：考试排名、比赛名次、作品是否好用（v0.7 起参与积分）。
 * 与 Quality 分开：Quality 是"做没做完"，EventResult 是"做出来什么结果"。
 */
export type EventResult = 'exceeded' | 'met' | 'below'
export type Priority = 0 | 1 | 2
export type NotifyChannel = 'inapp' | 'toast' | 'mail' | 'webhook'
export type ReminderLevel = 'normal' | 'strong'

/** 完成证据（S4 已定） */
export type Evidence =
  | { kind: 'text'; text: string; addedAt: string }
  | { kind: 'attachment'; attachmentId: string; addedAt: string }

export interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  title: string
  detailMd: string
  parentId: string | null
  sortKey: number
  priority: Priority
  difficulty: Difficulty
  estimateMin: number | null

  /** deadline: 截止时刻 | event: 发生时刻 | daily: null */
  dueAt: string | null
  /** daily 专用：每日提醒时刻 'HH:mm' */
  dailyTime: string | null
  /** daily 专用：'DAILY' | 'WEEKLY:1,3,5' | null(=每天) */
  repeatRule: string | null
  /** daily 专用：区间 YYYY-MM-DD */
  activeFrom: string | null
  activeTo: string | null

  /** 相对 dueAt 的分钟偏移，负数提前。deadline 默认 [-1440,-60]，event 默认 [-10080,-4320,-1440] */
  reminderOffsets: number[]
  reminderChannels: NotifyChannel[]

  tags: string[]
  /** 小数（2 位）。由 computePlannedPoints 算，不是整数，UI 用 fmtPoints 显示 */
  pointsPlanned: number
  /** deadline/event 才有值；daily 恒为 null，看 occurrences。同为小数 */
  pointsAwarded: number | null
  quality: Quality | null

  /** 完成是否必须附证据；由 AI 在建任务时判定，用户可改 */
  requiresEvidence: boolean
  evidence: Evidence[]

  /** daily 专用 */
  streakCurrent: number
  streakBest: number

  source: 'chat' | 'manual' | 'hud'
  aiConfidence: number | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  archivedAt: string | null
}

/** 创建/更新任务的入参，全部可选 = PATCH 语义 */
export interface TaskPatch {
  title?: string
  detailMd?: string
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
  requiresEvidence?: boolean
  tags?: string[]
}

/** 每日任务在某一天的这一次 */
export interface Occurrence {
  id: string
  taskId: string
  day: string // YYYY-MM-DD 本地
  status: 'pending' | 'done' | 'skipped' | 'missed'
  /** 小数（2 位），未完成为 null */
  pointsAwarded: number | null
  completedAt: string | null
  note: string | null
  /** 联表带出，渲染日历与今日列表时免二次查询 */
  taskTitle?: string
  taskType?: TaskType
}

/** 日历一个月的红点索引 */
export interface DayIndexEntry {
  day: string
  total: number // 该日任务总数
  doneCount: number // 其中已完成数
}

/** 点某日展开的条目。只含 deadline / event，不含每日任务（Q2 已定） */
export interface DayTaskItem {
  taskId: string
  type: 'deadline' | 'event'
  title: string
  time: string // 'HH:mm'，由 dueAt 转本地时刻
  dueAt: string
  status: 'todo' | 'doing' | 'reviewing' | 'done'
  points: number | null
}

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageKind = 'text' | 'task_draft' | 'task_review' | 'reminder' | 'error'
export type MessageStatus = 'pending' | 'streaming' | 'sent' | 'failed'

export interface Message {
  id: string
  threadId: string
  role: MessageRole
  kind: MessageKind
  contentMd: string
  meta: MessageMeta // 按 kind 收窄，见下
  linkedTaskId: string | null
  status: MessageStatus
  attachments: Attachment[]
  createdAt: string
}

export type MessageMeta =
  | { kind: 'none' }
  | { kind: 'task_draft'; drafts: TaskDraft[] }
  | { kind: 'task_review'; taskId: string; verdict: ReviewVerdict }
  | {
      kind: 'reminder'
      reminderId: string
      taskId: string | null
      title: string
      fireAt: string
      /** null = 绝对时间（每日任务按 dailyTime 触发）；否则为相对 dueAt 的分钟偏移，负数提前 */
      offsetMin: number | null
    }
  | { kind: 'error'; code: AppErrorCode; message: string; retryable: boolean }

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  url: string // 主进程已转成 `app://attach/<id>` 自定义协议，渲染层直接用
  mime: string
  bytes: number
  width: number | null
  height: number | null
}

export interface PointEntry {
  id: string
  taskId: string | null
  occurrenceId: string | null
  delta: number
  kind: 'award' | 'penalty' | 'adjust'
  reasonCode: 'task_done' | 'quality_bonus' | 'overdue_penalty' | 'manual_adjust' | 'streak_bonus'
  reasonText: string
  day: string // YYYY-MM-DD 本地
  createdAt: string
}

export interface Reminder {
  id: string
  taskId: string | null
  occurrenceId: string | null
  offsetMin: number | null // null = 绝对时间（每日任务）
  fireAt: string
  repeatRule: string | null
  channels: NotifyChannel[]
  level: ReminderLevel
  status: 'active' | 'fired' | 'paused' | 'cancelled' | 'failed'
  lastFiredAt: string | null
  firedChannels: NotifyChannel[]
  failReason: string | null
  createdAt: string
}

export interface DayStat {
  day: string // YYYY-MM-DD
  points: number
  tasksDone: number
  tasksCreated: number
  occurrencesDone: number
}

export interface TaskDraft {
  /** 客户端生成，用于在同一张草稿卡片内定位（不是数据库 id） */
  localId: string
  type: TaskType
  title: string
  detailMd: string
  difficulty: Difficulty
  estimateMin: number | null
  dueHint: string | null // deadline=截止 / event=发生时刻 / daily=null
  dailyTimeHint: string | null // 'HH:mm'，仅 daily
  activeToHint: string | null // 'YYYY-MM-DD'，仅 daily 的可选结束日期（04 §3.2 要求此控件）
  reminderOffsets: number[] // 相对 dueHint 的分钟偏移，负数提前；按 type 默认值填充，用户可改
  tags: string[]
  steps: DraftStep[]
  missingInfo: string[] // 信息不足时列出要问用户的点，可能为空
  requiresEvidence: boolean // AI 判定这项完成时是否需要证据
  confidence: number // 0~1
  pointsPlanned: number // 小数（2 位）。由 rubric 计算填充，AI 不给这个数
}

export interface DraftStep {
  localId: string
  title: string
  estimateMin: number | null
  done: boolean // 确认任务后作为子任务，默认 false
}

export interface ReviewVerdict {
  /** need_evidence = 判断不了，需要用户补证据后再判 */
  verdict: 'pass' | 'partial' | 'fail' | 'need_evidence'
  quality: Quality | null
  /** 仅 type='event' 有意义；其他类型传 null。event 的 quality 恒为 'met'，由 result 表达结果 */
  result: EventResult | null
  reason: string // 一句话，面向用户
  followup: string | null // 证据不足时的追问，可能为 null
  gaps: string[] // partial 时逐条列出未完成项，供卡片内展示；其他 verdict 为空数组
}

/** 外部通知通道的可插拔接口，见 §6 */
export interface NotificationChannel {
  id: NotifyChannel
  /** 是否已配置且可用；false 时调度器跳过该渠道且不报错 */
  available(): Promise<boolean>
  /** 发送一条提醒；抛错由 reminderService 落到 failReason，不做阻塞式重试 */
  send(payload: ReminderPayload): Promise<void>
}

export interface ReminderPayload {
  reminderId: string
  taskId: string | null
  type: TaskType | null
  title: string
  detail: string // 一句话摘要，用于 QQ / 邮件正文
  dueAt: string | null
  offsetLabel: string // '前 1 天' / '前 1 小时' / '每日 21:00'
  level: ReminderLevel
}
