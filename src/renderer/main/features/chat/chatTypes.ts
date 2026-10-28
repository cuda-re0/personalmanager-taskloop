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

/** 草稿卡片渲染所需的全部数据。points 由 useChatData 算好，卡片不碰公式。 */
export interface DraftView {
  draft: TaskDraft
  points: number
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
  /** 仅 activity：结果档，默认 'met'（04 §3.3）；其他类型为 null */
  result: EventResult | null
  /** 仅限时：`提前 4 天` / `逾期 3 天`；取不到 completedAt 为 null，整条不显示 */
  leadLabel: string | null
}

/**
 * 会话区的全部副作用出口。W3 阶段每个实现体只做本地 mock + TODO(W5)，
 * 组件本身不知道有没有后端。
 */
export interface ChatActions {
  patchDraft(localId: string, patch: DraftPatch): void
  confirmDraft(localId: string): void
  rejectDraft(localId: string): void
  retry(messageId: string): void
  openTask(taskId: string): void
  snoozeReminder(reminderId: string): void
  addEvidence(taskId: string): void
  removeEvidence(taskId: string, key: string): void
  reReview(taskId: string): void
  /** 活动卡片改选结果档（04 §3.3），分值随之重算 */
  setEventResult(taskId: string, result: EventResult): void
  completeTask(taskId: string): void
  continueTask(taskId: string): void
  markDoneWithoutPoints(taskId: string): void
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
