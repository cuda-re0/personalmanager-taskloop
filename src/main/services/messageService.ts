import type { Attachment, Message, MessageMeta, MessageStatus } from '../../shared/types/domain'
import { nowIso } from '../db/localDay'
import { newId } from '../db/ids'
import type { MessageInsert } from '../db/mappers'
import * as messageRepo from '../db/repositories/messageRepo'

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
}

export function patchMessage(id: string, input: PatchMessageInput): Message {
  return messageRepo.patch(id, input)
}

/** 最近 N 条，时间升序（Bootstrap 用） */
export function recentMessages(limit = 30): Message[] {
  return messageRepo.listRecent(limit)
}

export function listMessages(input: { before?: string; limit?: number } = {}): Message[] {
  const limit = input.limit ?? 30
  return input.before ? messageRepo.listBefore(input.before, limit) : messageRepo.listRecent(limit)
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
