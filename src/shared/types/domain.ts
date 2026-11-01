import type { AppErrorCode } from './ipc'

export type TaskType = 'daily' | 'deadline' | 'event'
export type TaskStatus =
  | 'todo'
  | 'doing'
  /** 等用户交材料（v0.38）：取消/超时回 doing，提交才进 reviewing */
  | 'pending_review'
  | 'reviewing'
  | 'done'
  /** 审核驳回且已过 due_at（v0.34）：终点状态，不计分、不写流水 */
  | 'missed'
  | 'discarded'
  | 'archived'
export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard' | 'epic'
export type Quality = 'partial' | 'met' | 'exceeded'
/** 活动任务的结果档（v0.7 起参与积分）；与 Quality 分开：Quality 是"做没做完"，这是"做出什么结果" */
export type EventResult = 'exceeded' | 'met' | 'below'
export type Priority = 0 | 1 | 2
export type NotifyChannel = 'inapp' | 'toast' | 'mail' | 'webhook'
export type ReminderLevel = 'normal' | 'strong'

/**
 * 完成证据（S4 已定）。
 * 图片与文件都走 attachment——是截图还是 PDF 由 Attachment.kind 决定，Evidence 不再区分。
 * 早先的 `kind:'image'` 让 `报告.pdf` 这类证据无处表达（04 §3.3 的示例里就有），故改为联合。
 */
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

/**
 * 创建侧 patch（02 §3.2 v0.15）：`TaskPatch` 全字段 + 可选 `type`。
 *
 * 只用于 `task.promoteDraft`——draft 尚未落库，"落库后不可改类型"约束的是 update 链路，
 * 确认本质是创建：patch 带 `type` 时按新类型落库 + `pointsPlanned` 按新类型口径重算 +
 * due 字段按类型映射；非法 type×difficulty 照旧只拒 `INVALID_INPUT`（主进程不归位）。
 * `task.update` 的 patch 仍是 `TaskPatch`（没有 `type`），落库后依旧不可改。
 */
export interface TaskCreatePatch extends TaskPatch {
  type?: TaskType
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
  /** v0.49：用户给的文件名（清洗后），气泡胶囊显示用。老行为空串 → 渲染层按 mime 兜底 */
  name: string
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
  /**
   * v0.45 起多一个 `spend`：零花钱支出。
   * 不复用 `adjust`——「手动调整」与「花钱」在明细里必须能分开看，混成一类就查不出账。
   */
  kind: 'award' | 'penalty' | 'adjust' | 'spend'
  reasonCode:
    | 'task_done'
    | 'quality_bonus'
    | 'overdue_penalty'
    | 'manual_adjust'
    | 'streak_bonus'
    | 'pocket_spend'
  reasonText: string
  day: string // YYYY-MM-DD 本地
  createdAt: string
  /**
   * 被冲销的时刻（01 §2.4，v0.19）。NULL = 这条发分仍然有效。
   * 撤销不删流水：原行打上时间戳、另写一条负流水，余额仍是 SUM(delta)。
   */
  reversedAt: string | null
  /**
   * 只有 `kind='spend'` 的行有值（v0.45）：这笔花了多少分（整数「分」）。
   * 其余行一律 NULL，**不许塞 0**——0 分支出和"不是支出"是两件事。
   */
  amountCents: number | null
  /** 只有 `kind='spend'` 的行有值：记账当时的汇率快照。改汇率永不重算历史 */
  fxRate: number | null
}

/**
 * 当周汇率（v0.45）。`basis` 是 AI 的评估依据，只进库不进渲染层，故不进这个类型。
 */
export interface FxRate {
  /** 该汇率生效的周一（本地日 YYYY-MM-DD） */
  weekStart: string
  /** 1 积分值多少元 */
  rate: number
  source: 'ai' | 'fallback'
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
  /**
   * 截止（deadline）/ 发生（event）时间，三档精度（03 §4.1 的 due_hint 原样，v0.53）：
   * - `2026-11-05T15:00:00.000Z` → 精确到分（归一成 UTC）
   * - `2026-11-05`                → 只知道哪天
   * - `2026-11`                   → 只知道哪个月
   *
   * `day` / `month` **必须原样保留，不许 `toISOString()`**——那等于替用户编一个零点。
   * **不要存 '10-30 18:00' 这种无年份形态**：跨年会错一年，而 due_at 同时喂提醒、
   * 逾期判定与效率系数三条链路；「截止瞬间」一律走 `@shared/due` 的 `dueInstant`。
   * 界面上显示成什么都由渲染层决定（04 §3.2）。daily 恒为 null。
   */
  dueHint: string | null
  dailyTimeHint: string | null // 'HH:mm'，仅 daily
  activeToHint: string | null // 'YYYY-MM-DD'，仅 daily 的可选结束日期（04 §3.2 要求此控件）
  reminderOffsets: number[] // 相对 dueHint 的分钟偏移，负数提前；按 type 默认值填充，用户可改
  tags: string[]
  steps: DraftStep[]
  missingInfo: string[] // 信息不足时列出要问用户的点，可能为空
  requiresEvidence: boolean // AI 判定这项完成时是否需要证据
  confidence: number // 0~1
  pointsPlanned: number // 小数（2 位）。AI 不给。按 type 分派：
  //   daily → settings['points.dailyBase']
  //   deadline / event → computePlannedPoints(difficulty)
  // **必须与卡片显示值完全一致**：W5 确认时直接写入
  // tasks.points_planned，两套口径会让每日任务变成每天 20 分
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
  /**
   * 仅 type='event' 有意义，其他类型传 null。
   * event 的得分**只看 result**（`quality` 不进公式，02 §5）；`task.complete` 收到什么
   * `quality` 就存什么，主进程不做强制改写——UI 侧对 event 恒传 `met`（v0.20 澄清）。
   */
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

/* ------------------------------------------------------------------ *
 * §2.11 聊天侧实体（v0.37 · 02 §2）
 * ------------------------------------------------------------------ */

/**
 * 聊天模式（v0.37）：**只由输入区的模式按钮决定**，禁止从文本内容推断。
 * 省略按 `'chat'`（02 §3.3）。
 */
export type ChatMode = 'chat' | 'task'

/** 人物卡语气档（v0.37）。只影响 03 §4.3 里的一句语气指令，不参与任何业务判断 */
export type PersonaTone = 'warm' | 'plain' | 'playful'

/** 人物卡（v0.37）。表支持多张，v1 只有一行 `isActive: true` */
export interface Persona {
  id: string
  name: string // 助手名字，1~20 字
  userCall: string // 怎么称呼用户，空串 = 用「你」
  personaMd: string // 用户自己写的人设正文，≤ 800 字，原样进 prompt
  tone: PersonaTone
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 记忆分类（v0.37）：profile=我是谁 / preference=我怎么被对待 / fact=可核对的事实 */
export type MemoryKind = 'profile' | 'preference' | 'fact'

/** 记忆来源（v0.37）：auto=模型自动提取，manual=用户手写。存储上完全平等，只用于区分与筛除 */
export type MemorySource = 'auto' | 'manual'

export interface Memory {
  id: string
  contentMd: string // 一条一句话，≤ 120 字，**全局唯一**
  kind: MemoryKind
  source: MemorySource
  hits: number // 被带进 system prompt 的次数，淘汰依据
  createdAt: string
  updatedAt: string
}
