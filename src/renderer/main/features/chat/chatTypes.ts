import type { Attachment, EventResult, Message, Task, TaskDraft } from '@shared/types/domain'

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
}

export interface ChatData {
  messages: Message[]
  draftViews: Record<string, DraftView>
  reviewViews: Record<string, ReviewView>
  sending: boolean
  hasMore: boolean
  loadingMore: boolean
  actions: ChatActions
  send(text: string, attachments: Attachment[]): void
  loadMore(): void
}
