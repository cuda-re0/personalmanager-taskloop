import type { Memory, MemoryKind, MemorySource } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { newId } from '../ids'
import { nowIso } from '../localDay'
import { placeholders } from '../sqlUtil'

/**
 * memories 的数据访问层（01 §2.9）。只做 SQL，不做业务判断——
 * 上限 50 条、淘汰时机、`INVALID_INPUT` 文案都在 `memoryService`。
 *
 * `content_md` 唯一：重复提取同一条是常态，`INSERT OR IGNORE` 让"已经记过"
 * 变成 no-op，不需要先查后写。
 */

const COLUMNS = ['id', 'content_md', 'kind', 'source', 'hits', 'created_at', 'updated_at'] as const
const SELECT = `SELECT ${COLUMNS.join(', ')} FROM memories`

interface MemoryRow {
  id: string
  content_md: string
  kind: string
  source: string
  hits: number
  created_at: string
  updated_at: string
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    contentMd: row.content_md,
    kind: row.kind as MemoryKind,
    source: row.source as MemorySource,
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** `updatedAt` 降序（02 §3.8）。tiebreaker 用 rowid 而不是 id：同毫秒落库时 id 是随机的 */
export function list(options: { source?: MemorySource; limit?: number } = {}): Memory[] {
  const limit = options.limit ?? 200
  const rows = options.source
    ? (getDb()
        .prepare(`${SELECT} WHERE source = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
        .all(options.source, limit) as MemoryRow[])
    : (getDb()
        .prepare(`${SELECT} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
        .all(limit) as MemoryRow[])
  return rows.map(mapMemory)
}

export function getById(id: string): Memory | null {
  const row = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as MemoryRow | undefined
  return row ? mapMemory(row) : null
}

export function getByContent(contentMd: string): Memory | null {
  const row = getDb().prepare(`${SELECT} WHERE content_md = ?`).get(contentMd) as
    | MemoryRow
    | undefined
  return row ? mapMemory(row) : null
}

export interface MemoryInsert {
  contentMd: string
  kind: MemoryKind
  source: MemorySource
}

/** `INSERT OR IGNORE`：撞唯一索引时不再写，返回**已有那条**（02 §3.8 的 `memory.add`） */
export function insert(input: MemoryInsert): Memory {
  const id = newId()
  const now = nowIso()
  try {
    const changes = getDb()
      .prepare(`INSERT OR IGNORE INTO memories (${COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.contentMd, input.kind, input.source, 0, now, now).changes
    if (changes === 0) {
      const existing = getByContent(input.contentMd)
      if (existing === null) {
        throw appError('DB_ERROR', '数据库读写失败', {
          detail: `INSERT OR IGNORE 未写入但查不到已存在行：${input.contentMd}`
        })
      }
      return existing
    }
  } catch (e) {
    throw wrapWriteError(e, '记忆写入失败')
  }
  return requireById(id)
}

export interface MemoryUpdate {
  contentMd?: string
  kind?: MemoryKind
}

/** 撞唯一索引原样抛 CONFLICT，由 service 翻成 `INVALID_INPUT`「这条记忆已经存在」 */
export function update(id: string, patch: MemoryUpdate): Memory {
  const sets: string[] = []
  const values: string[] = []
  if (patch.contentMd !== undefined) {
    sets.push('content_md = ?')
    values.push(patch.contentMd)
  }
  if (patch.kind !== undefined) {
    sets.push('kind = ?')
    values.push(patch.kind)
  }
  if (sets.length === 0) return requireById(id)

  sets.push('updated_at = ?')
  values.push(nowIso())
  try {
    const changes = getDb()
      .prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id).changes
    if (changes === 0) throw appError('NOT_FOUND', '记忆不存在', { detail: `id=${id}` })
  } catch (e) {
    throw wrapWriteError(e, '记忆写入失败')
  }
  return requireById(id)
}

export function remove(id: string): void {
  const changes = getDb().prepare('DELETE FROM memories WHERE id = ?').run(id).changes
  if (changes === 0) throw appError('NOT_FOUND', '记忆不存在', { detail: `id=${id}` })
}

export function count(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
  return row.n
}

/** 这批记忆被拼进 system prompt 了：一条 SQL 全 +1（01 §2.9 的 `hits`） */
export function touchHits(ids: readonly string[]): void {
  if (ids.length === 0) return
  getDb()
    .prepare(`UPDATE memories SET hits = hits + 1 WHERE id IN (${placeholders(ids.length)})`)
    .run(...ids)
}

/**
 * 淘汰一条：`hits` 升序 → `updated_at` 升序（最没用 + 最久没碰的先走）。
 * 硬删，不做软删、不归档（01 §2.9）。表空时返回 null。
 */
export function evictOne(): string | null {
  const row = getDb()
    .prepare('SELECT id FROM memories ORDER BY hits ASC, updated_at ASC, rowid ASC LIMIT 1')
    .get() as { id: string } | undefined
  if (!row) return null
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(row.id)
  return row.id
}

export function requireById(id: string): Memory {
  const found = getById(id)
  if (found === null) throw appError('NOT_FOUND', '记忆不存在', { detail: `id=${id}` })
  return found
}
