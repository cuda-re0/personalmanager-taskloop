import { getDb } from '../connection'
import { wrapWriteError } from '../errors'
import { nowIso } from '../localDay'

/**
 * chat_state 的数据访问层（01 §2.10）。单行表，`id` 恒为 `'main'`。
 *
 * 不暴露给渲染层：摘要只喂 `chat` 管线的 system prompt，界面不该看见。
 * 行不预置（迁移不写业务数据），`get()` 发现无行时就地插一行空摘要再返回。
 */

export const CHAT_STATE_ID = 'main'

export interface ChatState {
  id: string
  summaryMd: string
  uptoMessageId: string | null
  updatedAt: string
}

interface ChatStateRow {
  id: string
  summary_md: string
  upto_message_id: string | null
  updated_at: string
}

const SELECT = 'SELECT id, summary_md, upto_message_id, updated_at FROM chat_state'

function mapState(row: ChatStateRow): ChatState {
  return {
    id: row.id,
    summaryMd: row.summary_md,
    uptoMessageId: row.upto_message_id,
    updatedAt: row.updated_at
  }
}

export function get(): ChatState {
  const row = getDb().prepare(`${SELECT} WHERE id = ?`).get(CHAT_STATE_ID) as
    | ChatStateRow
    | undefined
  if (row) return mapState(row)

  const now = nowIso()
  try {
    getDb()
      .prepare('INSERT INTO chat_state (id, summary_md, upto_message_id, updated_at) VALUES (?, ?, ?, ?)')
      .run(CHAT_STATE_ID, '', null, now)
  } catch (e) {
    throw wrapWriteError(e, '会话摘要写入失败')
  }
  return { id: CHAT_STATE_ID, summaryMd: '', uptoMessageId: null, updatedAt: now }
}

export interface SummaryPatch {
  summaryMd: string
  uptoMessageId: string | null
}

export function setSummary(patch: SummaryPatch): ChatState {
  // 先 get() 保证行存在（无行时 UPDATE 会静默改 0 行）
  get()
  try {
    getDb()
      .prepare('UPDATE chat_state SET summary_md = ?, upto_message_id = ?, updated_at = ? WHERE id = ?')
      .run(patch.summaryMd, patch.uptoMessageId, nowIso(), CHAT_STATE_ID)
  } catch (e) {
    throw wrapWriteError(e, '会话摘要写入失败')
  }
  return get()
}
