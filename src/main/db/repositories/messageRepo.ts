import type { Message, MessageKind, MessageMeta, MessageStatus } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { MESSAGE_COLUMNS, mapMessage, messageInsertParams } from '../mappers'
import type { MessageInsert, MessageRow, SqlValue } from '../mappers'
import { buildSetClause, placeholders } from '../sqlUtil'
import { attachmentsFor } from './attachmentRepo'

/**
 * messages 的数据访问层。发送与 AI 编排在 W3/W4，这里只管行。
 *
 * 附件的行级函数在 W11 迁到了 `attachmentRepo`。这里**同名转出**其中四个
 * （`insertAttachment` / `listAttachments` / `attachToMessage` / `removeAttachment`），
 * `messageService` 的调用点（`messageRepo.insertAttachment` 等）一行都不用改；
 * `attachmentsFor` 只在本文件内部用（`getById` / `hydrate` 给消息带附件），import 进来、
 * **没有**转出——批量分组取是消息读取侧的事，外面要用请直接找 `attachmentRepo`。
 * 这一层只是兼容壳，新代码不要再往这里加附件函数。
 */

export {
  insert as insertAttachment,
  listAttachments,
  attachToMessage,
  remove as removeAttachment
} from './attachmentRepo'
export type { AttachmentInsert } from './attachmentRepo'

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

/**
 * 最近 N 条，按时间升序返回（Bootstrap 要的就是升序）。
 * tiebreaker 必须是 rowid 而不是 id：created_at 只有毫秒精度，id 是 randomBytes 纯随机，
 * 两条消息同毫秒落库时按 id 排是 50% 随机；rowid 是插入序，恒为全序。
 */
export function listRecent(limit = 30): Message[] {
  const rows = getDb()
    .prepare(`${SELECT_MESSAGE} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(limit) as MessageRow[]
  return hydrate(rows.reverse())
}

/**
 * 向前翻页：`before` 是消息 id，取它之前的 limit 条（返回升序）。
 * 排序与游标比较都用 rowid（理由同 listRecent）：before 语义不变——仍是 messageId，
 * 这里先查锚点行拿 rowid 再比较，rowid 不出 IPC、service 无感。
 */
export function listBefore(before: string, limit = 30): Message[] {
  const anchor = getDb()
    .prepare('SELECT created_at, rowid AS rid FROM messages WHERE id = ?')
    .get(before) as { created_at: string; rid: number } | undefined
  if (!anchor) throw appError('NOT_FOUND', '分页游标消息不存在', { detail: `id=${before}` })
  const rows = getDb()
    .prepare(
      `${SELECT_MESSAGE} WHERE (created_at < ?) OR (created_at = ? AND rowid < ?)
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(anchor.created_at, anchor.created_at, anchor.rid, limit) as MessageRow[]
  return hydrate(rows.reverse())
}

export function listByThread(threadId: string, limit = 30): Message[] {
  const rows = getDb()
    .prepare(`${SELECT_MESSAGE} WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(threadId, limit) as MessageRow[]
  return hydrate(rows.reverse())
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  return row.n
}

/* attachments 的数据访问已迁到 `attachmentRepo.ts`（W11），见文件头的转出说明 */

function hydrate(rows: MessageRow[]): Message[] {
  if (rows.length === 0) return []
  const byMessage = attachmentsFor(rows.map(r => r.id))
  return rows.map(row => mapMessage(row, byMessage.get(row.id) ?? []))
}

/** 仅用于测试与 W3 的类型校验：确认写入的 kind 在契约枚举内 */
export function isMessageKind(value: string): value is MessageKind {
  return ['text', 'task_draft', 'task_review', 'reminder', 'error'].includes(value)
}
