import type {
  Attachment,
  ChatMode,
  Message,
  MessageMeta,
  MessageStatus
} from '../../shared/types/domain'
import { nowIso } from '../db/localDay'
import { newId } from '../db/ids'
import { appError } from '../db/errors'
import { broadcast } from '../bus'
import type { MessageInsert } from '../db/mappers'
import * as messageRepo from '../db/repositories/messageRepo'
import * as alertService from './alertService'

/**
 * messageService —— **只做数据访问**（不调 AI、不编排流式推送，那是 W3/W4）。
 * 事件广播（`message.appended` / `message.patch`）由 W2 的 bus 负责，这里只管行。
 */

export interface AppendMessageInput {
  id?: string
  threadId?: string
  role: Message['role']
  kind: Message['kind']
  contentMd?: string
  meta?: MessageMeta
  linkedTaskId?: string | null
  status?: MessageStatus
  /** v0.73：发送模式；省略即 NULL（老语义） */
  mode?: ChatMode | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
  createdAt?: string
}

export function appendMessage(input: AppendMessageInput): Message {
  const normalized: MessageInsert = {
    id: input.id ?? newId(),
    threadId: input.threadId ?? 'main',
    role: input.role,
    kind: input.kind,
    contentMd: input.contentMd ?? '',
    meta: input.meta ?? { kind: 'none' },
    linkedTaskId: input.linkedTaskId ?? null,
    status: input.status ?? 'sent',
    mode: input.mode ?? null,
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    latencyMs: input.latencyMs ?? null,
    createdAt: input.createdAt ?? nowIso()
  }
  return messageRepo.insert(normalized)
}

export function getMessage(id: string): Message | null {
  return messageRepo.getById(id)
}

export function requireMessage(id: string): Message {
  return messageRepo.requireById(id)
}

export interface PatchMessageInput {
  contentMd?: string
  status?: MessageStatus
  meta?: MessageMeta
  linkedTaskId?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
  settledAt?: string | null
}

export function patchMessage(id: string, input: PatchMessageInput): Message {
  return messageRepo.patch(id, input)
}

/**
 * 会话区提醒行「知道了 / 稍后提醒」（v0.92）：只写 `messages.settled_at`。
 *
 * 幂等写死：已处理过就原样返回，不刷新时间戳、不广播——用户连点两下、
 * 两个窗口同时点，库里也只留第一次的时刻。顺带 ack 对应的 alert 行，
 * 但记不上不能连累界面状态（与 `reminderService.fireOne` 的 `recordAlert` 同口径）。
 */
export function settleReminderMessage(id: string): Message {
  const message = requireMessage(id)
  if (message.kind !== 'reminder') {
    throw appError('INVALID_INPUT', '只有提醒消息可以标记已处理', {
      detail: `kind=${message.kind}`
    })
  }
  if (message.settledAt !== null) return message

  const at = nowIso()
  const settled = patchMessage(id, { settledAt: at })

  if (message.meta.kind === 'reminder') {
    try {
      alertService.ackAlert(message.meta.reminderId)
    } catch (e: unknown) {
      console.warn('[alert] 确认失败', e)
    }
  }

  broadcast({ type: 'message.patch', messageId: id, patch: { settledAt: at } })
  return settled
}

/** 最近 N 条，时间升序（Bootstrap 用） */
export function recentMessages(limit = 30): Message[] {
  return messageRepo.listRecent(limit)
}

export function listMessages(input: { before?: string; limit?: number } = {}): Message[] {
  const limit = input.limit ?? 30
  return input.before ? messageRepo.listBefore(input.before, limit) : messageRepo.listRecent(limit)
}

/**
 * 最近 N 条 `kind='text'`，时间升序（03 §4.3.1 的 chat 历史上下文）。
 *
 * `excludeId` 传本轮用户消息的 id：`msg.send` 是**先落 user 消息再跑 runTurn**，
 * 不排掉它，同一句话会既在历史尾部、又作为本轮 user 再进一次 prompt。
 */
export function recentChatMessages(
  limit = 20,
  options: { excludeId?: string } = {}
): Message[] {
  return messageRepo.listRecentText(limit, options.excludeId)
}

/** 摘要窗口：`afterId` 之后的纯文本消息，时间升序（01 §2.10） */
export function textMessagesAfter(afterId: string | null, limit = 200): Message[] {
  return messageRepo.listTextAfter(afterId, limit)
}

export function attachFiles(messageId: string, attachmentIds: string[]): void {
  messageRepo.attachToMessage(messageId, attachmentIds)
}

export function listAttachments(messageId: string): Attachment[] {
  return messageRepo.listAttachments(messageId)
}

export function insertAttachment(input: messageRepo.AttachmentInsert): Attachment {
  return messageRepo.insertAttachment(input)
}
