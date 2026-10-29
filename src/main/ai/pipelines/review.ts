import type { ReviewVerdict, Task, TaskType } from '../../../shared/types/domain'
import { AI_COPY } from '../copy'
import { buildReviewSystem } from '../prompts'
import type { ChatContentPart, ChatMessage } from '../provider'
import type { ReviewResult } from '../schema'
import { toDataUrl } from './parse'

/**
 * review 管线：任务 + 证据 → `ReviewVerdict`。
 *
 * 一条**硬闸门**在模型之前：任务要求证据、而这次一条证据都没有时，直接返回
 * `need_evidence`，**不发请求**（开工词 §4.7、03 §4.2 判定标准第 2 条）。
 * 理由是钱和体验两头：这种请求模型只能回"看不见证据"，白花几秒和一次调用；
 * 而"没证据就先给分"是 S4 明令取消的口子——没证据就不发分。
 */

/** 证据的三种形态。图片走多模态，文件只在文字里提一句（模型读不了 PDF 字节） */
export type ReviewEvidencePart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; bytes: Buffer }
  | { kind: 'file'; mime: string }

const TYPE_LABEL: Record<TaskType, string> = {
  daily: '每日',
  deadline: '限时',
  event: '活动'
}

/**
 * 硬闸门。返回 null = 可以问模型；返回 verdict = 按 `need_evidence` 直接收工。
 *
 * 判据用**证据条数**而不是"证据内容像不像"：像不像只有模型能判，条数为零是确定事实。
 */
export function hardGateOf(task: Task, evidenceCount: number): ReviewVerdict | null {
  if (!task.requiresEvidence || evidenceCount > 0) return null
  return {
    verdict: 'need_evidence',
    quality: null,
    result: null,
    reason: AI_COPY.needEvidenceReason,
    followup: AI_COPY.needEvidenceFollowup,
    gaps: []
  }
}

export interface ReviewRequestInput {
  task: Task
  evidence: ReviewEvidencePart[]
  userText?: string
  now?: Date
  timeZone?: string
}

/** 任务摘要（文字）+ 图片证据（多模态）。证据编号与用户看到的一致，方便模型说"第 2 张" */
function taskBrief(task: Task, userText: string | undefined): string {
  const lines: string[] = []
  lines.push(`任务标题：${task.title}`)
  lines.push(`任务类型：${TYPE_LABEL[task.type]}`)
  if (task.dueAt !== null) {
    lines.push(`${task.type === 'event' ? '发生时间' : '截止时间'}：${task.dueAt}`)
  }
  lines.push(`是否要求证据：${task.requiresEvidence ? '是' : '否'}`)
  if (task.detailMd.trim().length > 0) lines.push(`任务描述：${task.detailMd.trim()}`)
  if (userText !== undefined && userText.trim().length > 0) {
    lines.push(`用户这一轮说：${userText.trim()}`)
  }
  return lines.join('\n')
}

export function buildReviewRequest(input: ReviewRequestInput): ChatMessage[] {
  const evidenceLines: string[] = []
  const imageParts: ChatContentPart[] = []
  let index = 0
  for (const item of input.evidence) {
    index += 1
    if (item.kind === 'text') {
      evidenceLines.push(`${index}. 文字证据：${item.text}`)
    } else if (item.kind === 'file') {
      evidenceLines.push(`${index}. 附件证据（无法预览内容，只能看到类型）：${item.mime}`)
    } else {
      evidenceLines.push(`${index}. 图片证据（见下）`)
      imageParts.push({ type: 'image_url', image_url: { url: toDataUrl(item) } })
    }
  }

  const header: ChatContentPart = {
    type: 'text',
    text:
      `${taskBrief(input.task, input.userText)}\n\n证据共 ${input.evidence.length} 条：\n` +
      (evidenceLines.length > 0 ? evidenceLines.join('\n') : '（无）')
  }

  return [
    { role: 'system', content: buildReviewSystem(input.now, input.timeZone) },
    { role: 'user', content: [header, ...imageParts] }
  ]
}

/**
 * `ReviewResult`（模型输出）→ `ReviewVerdict`（业务契约，domain.ts）。
 *
 * 两处**归一化**都在这里，不在 schema 里：
 * - `event` 的 `quality` 恒 `'met'`——活动看结果不看完成度（03 §4.7）；
 * - 非 event 的 `result` 恒 `null`——schema 已经拒了非 null，这里再收一道，
 *   免得将来有人改 schema 时忘了下游。
 */
export function toVerdict(raw: ReviewResult, type: TaskType): ReviewVerdict {
  const scored = raw.verdict === 'pass' || raw.verdict === 'partial'
  const quality = scored ? (type === 'event' ? 'met' : (raw.quality ?? 'met')) : null
  return {
    verdict: raw.verdict,
    quality,
    result: type === 'event' ? (raw.result ?? null) : null,
    reason: raw.reason,
    followup: raw.followup ?? null,
    // 04 §3.3：只有 partial 会在卡面逐条列缺口，其他 verdict 一律空数组
    gaps: raw.verdict === 'partial' ? (raw.gaps ?? []) : []
  }
}
