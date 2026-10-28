import type { PointEntry } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, isConstraintError, wrapWriteError } from '../errors'
import { LEDGER_COLUMNS, ledgerInsertParams, mapPointEntry } from '../mappers'
import type { PointEntryInsert, PointEntryRow } from '../mappers'
import { placeholders } from '../sqlUtil'

/**
 * point_ledger 的数据访问层。余额**不落地**，永远是 `SUM(delta)`（01 §1）。
 * 流水一旦写入就是事实，本层不提供 UPDATE / DELETE，撤销靠写负流水。
 */

const SELECT_LEDGER = `SELECT ${LEDGER_COLUMNS.join(', ')} FROM point_ledger`

/** 把两条条件唯一索引的冲突翻成人话（分别对应限时/活动与每日任务） */
function conflictMessage(e: unknown): string | null {
  if (!isConstraintError(e)) return null
  const raw = e instanceof Error ? e.message : ''
  if (raw.includes('point_ledger.occurrence_id')) return '这一天的打卡已经发过分了'
  if (raw.includes('point_ledger.task_id')) return '这个任务已经发过完成分了'
  return '流水重复，已被唯一索引拒绝'
}

export function insert(entry: PointEntryInsert): PointEntry {
  try {
    getDb()
      .prepare(
        `INSERT INTO point_ledger (${LEDGER_COLUMNS.join(', ')})
         VALUES (${placeholders(LEDGER_COLUMNS.length)})`
      )
      .run(...ledgerInsertParams(entry))
  } catch (e) {
    const message = conflictMessage(e)
    if (message) {
      throw appError('CONFLICT', message, {
        detail: e instanceof Error ? e.message : String(e),
        cause: e
      })
    }
    throw wrapWriteError(e, '积分流水写入失败')
  }
  const row = getDb().prepare(`${SELECT_LEDGER} WHERE id = ?`).get(entry.id) as PointEntryRow
  return mapPointEntry(row)
}

/** 余额 = SUM(delta)。不做 round——roundPoints 全项目只允许出现在 rubric.ts 一处 */
export function balance(): number {
  const row = getDb().prepare('SELECT COALESCE(SUM(delta), 0) AS total FROM point_ledger').get() as {
    total: number
  }
  return row.total
}

export function sumByDay(day: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(delta), 0) AS total FROM point_ledger WHERE day = ?')
    .get(day) as { total: number }
  return row.total
}

export interface ListLedgerOptions {
  from?: string
  to?: string
  limit?: number
}

export function list(options: ListLedgerOptions = {}): PointEntry[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (options.from) {
    where.push('day >= ?')
    params.push(options.from)
  }
  if (options.to) {
    where.push('day <= ?')
    params.push(options.to)
  }
  let sql = SELECT_LEDGER
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`
  sql += ' ORDER BY created_at DESC, id DESC'
  if (options.limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }
  return (getDb().prepare(sql).all(...params) as PointEntryRow[]).map(mapPointEntry)
}

export function recent(limit = 20): PointEntry[] {
  return list({ limit })
}

export function listByTask(taskId: string): PointEntry[] {
  return (getDb()
    .prepare(`${SELECT_LEDGER} WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
    .all(taskId) as PointEntryRow[]).map(mapPointEntry)
}

/** 限时/活动是否已经发过完成分（业务层判重也能靠唯一索引，这个只是给 UI 提前判断用） */
export function hasTaskDoneEntry(taskId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS hit FROM point_ledger
       WHERE task_id = ? AND reason_code = 'task_done' AND occurrence_id IS NULL LIMIT 1`
    )
    .get(taskId) as { hit: number } | undefined
  return row !== undefined
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM point_ledger').get() as { n: number }
  return row.n
}
