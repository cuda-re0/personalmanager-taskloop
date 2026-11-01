import type { Attachment } from '../../../shared/types/domain'
import { getDb, tx } from '../connection'
import { wrapWriteError } from '../errors'
import { ATTACHMENT_COLUMNS, mapAttachment } from '../mappers'
import type { AttachmentRow, SqlValue } from '../mappers'
import { placeholders } from '../sqlUtil'

/**
 * `attachments` 的行级数据访问层（W11 从 `messageRepo` 迁出）。
 *
 * 职责边界：
 * - 这里**只管行**，不碰磁盘。落盘、sha256、去重判定在 `services/attachmentService.ts`
 * - 返回两种形态：`Attachment`（契约类型，给 IPC 与消息带附件用）和 `AttachmentRow`
 *   （带 `rel_path` / `sha256`，给协议处理器与去重用）。契约里的 `Attachment` 没有
 *   `relPath`，所以需要行的地方必须走 `attachmentRowById`，不要往类型里加字段
 * - `messageRepo` 仍在转出 `insertAttachment` / `listAttachments` / `attachToMessage`，
 *   `messageService` 的调用点一行没动
 */

const SELECT_ATTACHMENT = `SELECT ${ATTACHMENT_COLUMNS.join(', ')} FROM attachments`

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
  /** v0.49 显示名；**可选**，省略即空串（老测试的 insert 不用逐个补） */
  name?: string
}

function insertParams(a: AttachmentInsert): SqlValue[] {
  return [
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
    a.createdAt,
    a.name ?? ''
  ]
}

export function insert(a: AttachmentInsert): Attachment {
  try {
    getDb()
      .prepare(
        `INSERT INTO attachments (${ATTACHMENT_COLUMNS.join(', ')})
         VALUES (${placeholders(ATTACHMENT_COLUMNS.length)})`
      )
      .run(...insertParams(a))
  } catch (e) {
    throw wrapWriteError(e, '附件记录写入失败')
  }
  const row = attachmentRowById(a.id)
  if (!row) throw wrapWriteError(new Error('插入后读不回'), '附件记录写入失败')
  return mapAttachment(row)
}

/** 整行（带 rel_path / sha256）。协议处理器与 attachmentService 只需要这个 */
export function attachmentRowById(id: string): AttachmentRow | null {
  const row = getDb().prepare(`${SELECT_ATTACHMENT} WHERE id = ?`).get(id) as
    | AttachmentRow
    | undefined
  return row ?? null
}

/** 契约类型（不含 rel_path）。给 IPC / W3 的编辑路径用 */
export function attachmentById(id: string): Attachment | null {
  const row = attachmentRowById(id)
  return row ? mapAttachment(row) : null
}

/**
 * 按 `(sha256, mime)` 查重（`idx_attachments_sha`，02 §3.3b v0.13）。
 * 键里必须带 mime：只看 sha256 的话，同一份字节被声明成两种 mime 会复用第一次的
 * 扩展名（`...png`）而新行记第二种 mime，路径与 Content-Type 长期不一致。
 * 命中即"磁盘上已有同内容同类型的文件"，服务层复用它那行的 `rel_path`、另插一行新记录。
 */
export function findBySha(sha256: string, mime: string): AttachmentRow | null {
  const row = getDb()
    .prepare(`${SELECT_ATTACHMENT} WHERE sha256 = ? AND mime = ? LIMIT 1`)
    .get(sha256, mime) as AttachmentRow | undefined
  return row ?? null
}

/** 某条消息的附件（按插入顺序） */
export function listAttachments(messageId: string): Attachment[] {
  return (
    getDb()
      .prepare(`${SELECT_ATTACHMENT} WHERE message_id = ? ORDER BY rowid`)
      .all(messageId) as AttachmentRow[]
  ).map(mapAttachment)
}

/** 批量取附件，按 message_id 分组；SQLite 变量上限按 500 一批切开 */
export function attachmentsFor(messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>()
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500)
    const rows = getDb()
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS.join(', ')} FROM attachments
         WHERE message_id IN (${placeholders(chunk.length)})
         ORDER BY rowid`
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

/** 把已经落盘的附件挂到某条消息上（`msg.send` 先 add 后挂） */
export function attachToMessage(messageId: string, attachmentIds: string[]): void {
  if (attachmentIds.length === 0) return
  tx(() => {
    const stmt = getDb().prepare('UPDATE attachments SET message_id = ? WHERE id = ?')
    for (const id of attachmentIds) stmt.run(messageId, id)
  })
}

/**
 * 只删行，**不删磁盘文件**（02 §3.3b：物理文件 v1 只增不删）。
 * 同一个文件可能被多条记录共享，删文件会把别人正在用的图弄丢。
 */
export function remove(id: string): void {
  getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id)
}
