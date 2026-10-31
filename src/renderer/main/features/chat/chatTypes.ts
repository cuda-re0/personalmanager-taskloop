import type {
  Attachment,
  ChatMode,
  EventResult,
  Message,
  Task,
  TaskDraft
} from '@shared/types/domain'

/** 草稿卡片里可就地修改的字段（04 §3.2：标题、类型、难度、时长、时间、每日结束日期） */
export type DraftPatch = Partial<
  Pick<
    TaskDraft,
    | 'title'
    | 'type'
    | 'difficulty'
    | 'estimateMin'
    | 'dueHint'
    | 'dailyTimeHint'
    | 'activeToHint'
    | 'reminderOffsets'
  >
>

/** 草稿卡片渲染数据。分值直接读 draft.pointsPlanned（归一后与显示同值）。 */
export interface DraftView {
  draft: TaskDraft
  /** datetime-local 控件值 'YYYY-MM-DDTHH:mm'，仅 deadline / event 用 */
  dueLocal: string
  /** 非 null = 已确认，卡片变灰、按钮消失 */
  confirmedTaskId: string | null
}

/**
 * 证据渲染数据。kind 与 Evidence 一致（text | attachment）；
 * 是截图还是 PDF 看 Attachment.kind —— Evidence 本身不再区分（v0.8）。
 */
export interface EvidenceView {
  key: string
  kind: 'text' | 'attachment'
  text: string | null
  url: string | null
  /** 仅 kind='attachment' 有值，决定渲染缩略图还是文件块 */
  attachmentKind: 'image' | 'file' | null
  mime: string | null
}

/** 审核卡片渲染数据。awarded 由 useChatData 用 rubric 算好。 */
export interface ReviewView {
  task: Task
  planned: number
  awarded: number | null
  evidence: EvidenceView[]
  /** 连续 need_evidence 次数，>=3 才出现「直接标记完成（不计分）」 */
  needEvidenceCount: number
  /** 该任务最后一条审核卡（v0.36）：只有它带动作按钮，更早的卡只读 */
  isLatest: boolean
  /** 仅 activity：AI 判的那一档（04 §3.3 v0.35 起卡片不给下拉）；其他类型为 null */
  result: EventResult | null
  /** 仅限时：`提前 4 天` / `逾期 3 天`；取不到 completedAt 为 null，整条不显示 */
  leadLabel: string | null
}

/**
 * 会话区的全部副作用出口。组件本身不知道有没有后端。
 *
 * v0.36：审核卡只剩三个动作——补证据、重审、不计分直达。`completeTask` / `continueTask`
 * / `setEventResult` / `removeEvidence` 已删（pass 自动完成、驳回自动回 doing 或判 missed，
 * 结果档下拉与移除按钮都没有存在理由）。
 *
 * v0.38：点完成改走「待提交」，新增 `submitReview` / `cancelSubmit`（只给待提交卡用）。
 */
export interface ChatActions {
  patchDraft(localId: string, patch: DraftPatch): void
  confirmDraft(localId: string): void
  rejectDraft(localId: string): void
  retry(messageId: string): void
  openTask(taskId: string): void
  snoozeReminder(reminderId: string): void
  /** 选完文件调：内部 `attachment.add` → `task.addEvidence`。失败返回 AppError.message 原文 */
  addEvidence(taskId: string, file: File): Promise<string | null>
  /** 补完证据后重跑 AI 审核（内部走 reviewFlow.runReview）。失败返回原文 */
  reReview(taskId: string): Promise<string | null>
  /** 连续 3 次 need_evidence 后的防死锁出口：`task.complete({ noPoints:true })` */
  markDoneWithoutPoints(taskId: string): Promise<string | null>
  /** 审核卡上的取消（v0.38）：`transition({to:'doing'})`，任务回进行中、不发分 */
  cancelSubmit(taskId: string): Promise<string | null>
  /** 待提交卡上的提交（v0.38）：`transition({to:'reviewing'})` → 送审。失败返回原文 */
  submitReview(taskId: string): Promise<string | null>
}

export interface ChatData {
  messages: Message[]
  /**
   * 真正交给 `MessageList` 渲染的数组（v0.39 §3）：同一任务只留最新一张审核卡。
   * `messages` 保留全量——翻页拼接、`reviewViews` 的 `isLatest` 都还按全量算。
   */
  visibleMessages: Message[]
  /**
   * taskId → 最近一次驳回要求补什么（v0.41 §2.2）。**没有这个 key 就不显示理由行**，
   * 不存空串——待提交卡按「有没有 key」决定那一行进不进 DOM。
   */
  needEvidenceHint: Record<string, string>
  draftViews: Record<string, DraftView>
  reviewViews: Record<string, ReviewView>
  /**
   * 待提交卡（v0.38）：由 `status === 'pending_review'` 派生，**不是消息**。
   * 按 `updatedAt` 升序（先进的在上）；提交中的任务仍留在列表里（`submittingIds`），
   * 否则 transition 到 reviewing 的那一瞬卡片就消失、等 AI 的几秒里界面上什么都没有。
   */
  pendingSubmit: Task[]
  /** 正在提交的任务 id（按钮与证据区一并禁用） */
  submittingIds: ReadonlySet<string>
  /** 证据附件元数据（`Attachment.url/kind/mime`），待提交卡渲染缩略图要用 */
  attachmentById: Record<string, Attachment>
  sending: boolean
  hasMore: boolean
  loadingMore: boolean
  actions: ChatActions
  /**
   * 当前模式（v0.37）：`task` 建任务（默认）/ `chat` 闲聊。
   * **不持久化**——重启回 `task`；切换不清空输入框内容。
   */
  mode: ChatMode
  /** 模式按钮点击：`task` ↔ `chat` */
  toggleMode(): void
  /**
   * 发一条消息。`mode` 由调用方从 `mode` 状态透传（主进程不猜内容）；
   * 省略时按 `'chat'`（02 §3.3）。
   */
  send(text: string, attachments: Attachment[], mode?: ChatMode): void
  loadMore(): void
}
