import type { Alert } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { ALERT_COLUMNS, mapAlert } from '../mappers'
import type { AlertRow } from '../mappers'

/**
 * alerts 的数据访问层（v0.88）。
 *
 * 与 `pulseRepo` 同口径：`getDb().prepare(...)` 直取、写操作包 `wrapWriteError`。
 * 时间列全是 UTC ISO8601（`toISOString()`），所以超时判定直接用字符串比较——
 * 字典序即时间序，不必把行拉回 JS 再算。
 */

const SELECT_ALERT = `SELECT ${ALERT_COLUMNS.join(', ')} FROM alerts`

function write<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw wrapWriteError(e, '提醒记录写入失败')
  }
}

export interface AlertInsert {
  id: string
  kind: Alert['kind']
  level: Alert['level']
  sourceId: string
  title: string
  firedAt: string
}

function selectById(id: string): Alert | null {
  const row = getDb().prepare(`${SELECT_ALERT} WHERE id = ?`).get(id) as AlertRow | undefined
  return row ? mapAlert(row) : null
}

/** 新记录：`acked_at` / `escalated_at` 均为 NULL，返回落库后的行 */
export function insert(input: AlertInsert): Alert {
  write(() =>
    getDb()
      .prepare(`INSERT INTO alerts (${ALERT_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.id,
        input.kind,
        input.level,
        input.sourceId,
        input.title,
        input.firedAt,
        null,
        null
      )
  )
  const alert = selectById(input.id)
  if (alert === null) throw appError('DB_ERROR', '提醒记录写入失败', { detail: `id=${input.id}` })
  return alert
}

/** 确认：只写还没确认过的行，返回 changes（0 = 没有匹配行，调用方不当错误） */
export function ackBySourceId(sourceId: string, at: string): number {
  return write(() =>
    getDb()
      .prepare('UPDATE alerts SET acked_at = ? WHERE source_id = ? AND acked_at IS NULL')
      .run(at, sourceId).changes
  )
}

/**
 * 超时未确认 → 标 escalated。一条 SQL 里按 level 分两档：
 * `strong` 用 `strongBefore`、其余用 `normalBefore`，两边都是「fired_at 早于边界」。
 * 参数顺序与 SQL 里 `?` 的出现顺序一致：at, strongBefore, normalBefore。
 */
export function escalateDue(normalBefore: string, strongBefore: string, at: string): number {
  return write(() =>
    getDb()
      .prepare(
        `UPDATE alerts SET escalated_at = ?
         WHERE acked_at IS NULL AND escalated_at IS NULL
           AND ((level = 'strong' AND fired_at <= ?) OR (level <> 'strong' AND fired_at <= ?))`
      )
      .run(at, strongBefore, normalBefore).changes
  )
}

/** 按触发时间升序；不按 acked 过滤——要不要看确认过的由调用方决定 */
export function listSince(sinceIso: string): Alert[] {
  return (
    getDb()
      .prepare(`${SELECT_ALERT} WHERE fired_at >= ? ORDER BY fired_at ASC`)
      .all(sinceIso) as AlertRow[]
  ).map(mapAlert)
}

/** 最近 limit 条，新→旧；调用方要升序自己反转 */
export function listRecent(limit: number): Alert[] {
  return (
    getDb()
      .prepare(`${SELECT_ALERT} ORDER BY fired_at DESC LIMIT ?`)
      .all(limit) as AlertRow[]
  ).map(mapAlert)
}
