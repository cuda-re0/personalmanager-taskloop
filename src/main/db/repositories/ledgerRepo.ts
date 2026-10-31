import type { PointEntry } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, isConstraintError, wrapWriteError } from '../errors'
import { LEDGER_COLUMNS, ledgerInsertParams, mapPointEntry } from '../mappers'
import type { PointEntryInsert, PointEntryRow } from '../mappers'
import { placeholders } from '../sqlUtil'

/**
 * point_ledger 的数据访问层。余额**不落地**，永远是 `SUM(delta)`（01 §1）。
 * 流水一旦写入就是事实，本层不提供 DELETE，也不改任何金额。
 *
 * 唯一的 UPDATE 是 `markReversed`（01 §2.4，v0.19）：冲销时给原发分行打一个
 * `reversed_at` 时间戳，让两条条件唯一索引的谓词（`reversed_at IS NULL`）放行"重做"。
 * 金额、kind、reason_code 一概不动——审计仍然看得出哪条被冲了、什么时候冲的。
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

/** 按 id 取一条（v0.45）：撤销支出要先拿到原行，不能靠区间反查（跨月就找不到了） */
export function byId(id: string): PointEntry | null {
  const row = getDb().prepare(`${SELECT_LEDGER} WHERE id = ?`).get(id) as PointEntryRow | undefined
  return row === undefined ? null : mapPointEntry(row)
}

/**
 * 区间内**有效**支出合计（v0.45，45 §4.3）。
 *
 * 只算 `kind='spend'` 且未被冲销的行：撤销之后再统计，这笔钱就不该还占着额度。
 * 冲销行本身是 `kind='adjust'` 的负流水，天然不在这个口径里。
 */
export function sumSpendCents(from: string, to: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM point_ledger
       WHERE kind = 'spend' AND reversed_at IS NULL AND day >= ? AND day <= ?`
    )
    .get(from, to) as { total: number }
  return row.total
}

/** 区间内的有效支出行（v0.45）：支出页按 createdAt 倒序渲染 */
export function listSpend(from: string, to: string): PointEntry[] {
  return (getDb()
    .prepare(
      `${SELECT_LEDGER}
       WHERE kind = 'spend' AND reversed_at IS NULL AND day >= ? AND day <= ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(from, to) as PointEntryRow[]).map(mapPointEntry)
}

/** 限时/活动是否已经发过完成分（业务层判重也能靠唯一索引，这个只是给 UI 提前判断用） */
export function hasTaskDoneEntry(taskId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS hit FROM point_ledger
       WHERE task_id = ? AND reason_code = 'task_done' AND occurrence_id IS NULL
         AND reversed_at IS NULL
       LIMIT 1`
    )
    .get(taskId) as { hit: number } | undefined
  return row !== undefined
}

/**
 * 把一条流水标为已冲销（01 §2.4）。撤销的后半截：原行打时间戳、另写负流水。
 *
 * 只允许冲销一次。`changes === 0` 说明这条不存在或已经冲过，属调用方的逻辑错误
 * （重复冲销会多写一条负流水，把余额扣两次），按内部故障 `DB_ERROR` 抛——04 §1.2，只进日志。
 */
export function markReversed(id: string, at: string): void {
  const info = getDb()
    .prepare('UPDATE point_ledger SET reversed_at = ? WHERE id = ? AND reversed_at IS NULL')
    .run(at, id)
  if (info.changes === 0) {
    throw appError('DB_ERROR', '流水冲销状态异常', {
      detail: `point_ledger ${id} 不存在或已经被冲销过`,
      retryable: false
    })
  }
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM point_ledger').get() as { n: number }
  return row.n
}
