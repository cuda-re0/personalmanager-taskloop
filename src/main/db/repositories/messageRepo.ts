import type { Attachment, Message, MessageKind, MessageMeta, MessageStatus } from '../../../shared/types/domain'
import { getDb, tx } from '../connection'
import { appError, wrapWriteError } from '../errors'
import {
  ATTACHMENT_COLUMNS,
  MESSAGE_COLUMNS,
  mapAttachment,
  mapMessage,
  messageInsertParams
} from '../mappers'
import type { AttachmentRow, MessageInsert, MessageRow, SqlValue } from '../mappers'
import { buildSetClause, placeholders } from '../sqlUtil'

/** messages / attachments 的数据访问层。发送与 AI 编排在 W3/W4，这里只管行。 */

const SELECT_MESSAGE = `SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages`

export function insert(input: MessageInsert): Message {
  try {
    getDb()
      .prepare(
        `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')})
         VALUES (${placeholders(MESSAGE_COLUMNS.length)})`
      )
      .run(...messageInsertParams(input))
  } catch (e) {
    throw wrapWriteError(e, '消息写入失败')
  }
  return requireById(input.id)
}

export function getById(id: string): Message | null {
  const row = getDb().prepare(`${SELECT_MESSAGE} WHERE id = ?`).get(id) as MessageRow | undefined
  if (!row) return null
  return mapMessage(row, attachmentsFor([id]).get(id) ?? [])
}

export function requireById(id: string): Message {
  const message = getById(id)
  if (!message) throw appError('NOT_FOUND', '消息不存在', { detail: `id=${id}` })
  return message
}

export interface MessagePatch {
  contentMd?: string
  status?: MessageStatus
  meta?: MessageMeta
  linkedTaskId?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
}

/** 02 §3.8：`message.patch` 只允许 contentMd / status / meta。其余字段是内部埋点，这里放开但注释标明 */
export function patch(id: string, input: MessagePatch): Message {
  const cols: Record<string, SqlValue> = {}
  if (input.contentMd !== undefined) cols.content_md = input.contentMd
  if (input.status !== undefined) cols.status = input.status
  if (input.meta !== undefined) cols.meta_json = JSON.stringify(input.meta)
  if (input.linkedTaskId !== undefined) cols.linked_task_id = input.linkedTaskId
  if (input.tokensIn !== undefined) cols.tokens_in = input.tokensIn
  if (input.tokensOut !== undefined) cols.tokens_out = input.tokensOut
  if (input.latencyMs !== undefined) cols.latency_ms = input.latencyMs
  if (Object.keys(cols).length === 0) return requireById(id)

  const { clause, values } = buildSetClause(cols)
  const changes = getDb()
    .prepare(`UPDATE messages SET ${clause} WHERE id = ?`)
    .run(...values, id).changes
  if (changes === 0) throw appError('NOT_FOUND', '消息不存在', { detail: `id=${id}` })
  return requireById(id)
}

/** 最近 N 条，按时间升序返回（Bootstrap 要的就是升序） */
export function listRecent(limit = 30): Message[] {
  const rows = getDb()
    .prepare(`${SELECT_MESSAGE} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as MessageRow[]
  return hydrate(rows.reverse())
}

/** 向前翻页：`before` 是消息 id，取它之前的 limit 条（返回升序） */
export function listBefore(before: string, limit = 30): Message[] {
  const anchor = getById(before)
  if (!anchor) throw appError('NOT_FOUND', '分页游标消息不存在', { detail: `id=${before}` })
  const rows = getDb()
    .prepare(
      `${SELECT_MESSAGE} WHERE (created_at < ?) OR (created_at = ? AND id < ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(anchor.createdAt, anchor.createdAt, anchor.id, limit) as MessageRow[]
  return hydrate(rows.reverse())
}

export function listByThread(threadId: string, limit = 30): Message[] {
  const rows = getDb()
    .prepare(
      `${SELECT_MESSAGE} WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(threadId, limit) as MessageRow[]
  return hydrate(rows.reverse())
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  return row.n
}

/* ------------------------------------------------------------------ *
 * attachments（只读 + 插入；附件落盘是 W7 的事）
 * ------------------------------------------------------------------ */

export interface AttachmentInsert {
  id: string
  messageId: string | null
  taskId?: string | null
  kind: Attachment['kind']
  relPath: string
  mime: string
  bytes: number
  width?: number | null
  height?: number | null
  sha256: string
  createdAt: string
}

export function insertAttachment(a: AttachmentInsert): Attachment {
  const values: SqlValue[] = [
    a.id,
    a.messageId,
    a.taskId ?? null,
    a.kind,
    a.relPath,
    a.mime,
    a.bytes,
    a.width ?? null,
    a.height ?? null,
    a.sha256,
    a.createdAt
  ]
  try {
    getDb()
      .prepare(
        `INSERT INTO attachments (${ATTACHMENT_COLUMNS.join(', ')})
         VALUES (${placeholders(ATTACHMENT_COLUMNS.length)})`
      )
      .run(...values)
  } catch (e) {
    throw wrapWriteError(e, '附件记录写入失败')
  }
  const row = getDb()
    .prepare(`SELECT ${ATTACHMENT_COLUMNS.join(', ')} FROM attachments WHERE id = ?`)
    .get(a.id) as AttachmentRow
  return mapAttachment(row)
}

export function listAttachments(messageId: string): Attachment[] {
  return (
    getDb()
      .prepare(`SELECT ${ATTACHMENT_COLUMNS.join(', ')} FROM attachments WHERE message_id = ?`)
      .all(messageId) as AttachmentRow[]
  ).map(mapAttachment)
}

export function attachToMessage(messageId: string, attachmentIds: string[]): void {
  if (attachmentIds.length === 0) return
  tx(() => {
    const stmt = getDb().prepare('UPDATE attachments SET message_id = ? WHERE id = ?')
    for (const id of attachmentIds) stmt.run(messageId, id)
  })
}

/** 批量取附件，按 message_id 分组；SQLite 变量上限按 500 一批切开 */
function attachmentsFor(messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>()
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500)
    const rows = getDb()
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS.join(', ')} FROM attachments
         WHERE message_id IN (${placeholders(chunk.length)})`
      )
      .all(...chunk) as AttachmentRow[]
    for (const row of rows) {
      const key = row.message_id ?? ''
      const list = out.get(key) ?? []
      list.push(mapAttachment(row))
      out.set(key, list)
    }
  }
  return out
}

function hydrate(rows: MessageRow[]): Message[] {
  if (rows.length === 0) return []
  const byMessage = attachmentsFor(rows.map(r => r.id))
  return rows.map(row => mapMessage(row, byMessage.get(row.id) ?? []))
}

/** 仅用于测试与 W3 的类型校验：确认写入的 kind 在契约枚举内 */
export function isMessageKind(value: string): value is MessageKind {
  return ['text', 'task_draft', 'task_review', 'reminder', 'error'].includes(value)
}
