import type { Occurrence } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { newId } from '../ids'
import {
  OCCURRENCE_COLUMNS,
  OCCURRENCE_COLUMNS_JOINED,
  mapOccurrence
} from '../mappers'
import type { OccurrenceRow, SqlValue } from '../mappers'
import { buildSetClause } from '../sqlUtil'

/** task_occurrences 的数据访问层。生成规则见 occurrenceService.ensureRange。 */

const SELECT_OCCURRENCE = `SELECT ${OCCURRENCE_COLUMNS.join(', ')} FROM task_occurrences`
const SELECT_OCCURRENCE_JOINED = `SELECT ${OCCURRENCE_COLUMNS_JOINED.join(', ')}
  FROM task_occurrences o JOIN tasks t ON t.id = o.task_id`

/**
 * 幂等插入：靠 `uq_occurrence_task_day` + INSERT OR IGNORE 兜底，调用 N 次不会变多。
 * 返回 true 表示这次真的插入了新行。
 */
export function insertIfAbsent(taskId: string, day: string, createdAt: string): boolean {
  try {
    return (
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO task_occurrences
             (id, task_id, day, status, points_awarded, completed_at, note, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`
        )
        .run(newId(), taskId, day, createdAt, createdAt).changes > 0
    )
  } catch (e) {
    throw wrapWriteError(e, '每日任务的当天记录写入失败')
  }
}

export function getById(id: string): Occurrence | null {
  const row = getDb().prepare(`${SELECT_OCCURRENCE} WHERE id = ?`).get(id) as OccurrenceRow | undefined
  return row ? mapOccurrence(row) : null
}

export function requireById(id: string): Occurrence {
  const occ = getById(id)
  if (!occ) throw appError('NOT_FOUND', '打卡记录不存在', { detail: `id=${id}` })
  return occ
}

export function listByDay(day: string): Occurrence[] {
  return (getDb()
    .prepare(`${SELECT_OCCURRENCE_JOINED} WHERE o.day = ? ORDER BY t.sort_key ASC, o.id ASC`)
    .all(day) as OccurrenceRow[]).map(mapOccurrence)
}

export function listByRange(from: string, to: string): Occurrence[] {
  return (getDb()
    .prepare(
      `${SELECT_OCCURRENCE_JOINED} WHERE o.day >= ? AND o.day <= ?
       ORDER BY o.day ASC, t.sort_key ASC, o.id ASC`
    )
    .all(from, to) as OccurrenceRow[]).map(mapOccurrence)
}

export function listByTask(taskId: string): Occurrence[] {
  return (getDb()
    .prepare(`${SELECT_OCCURRENCE} WHERE task_id = ? ORDER BY day ASC`)
    .all(taskId) as OccurrenceRow[]).map(mapOccurrence)
}

export interface OccurrenceUpdate {
  status?: Occurrence['status']
  pointsAwarded?: number | null
  completedAt?: string | null
  note?: string | null
}

export function update(id: string, patch: OccurrenceUpdate, updatedAt: string): Occurrence {
  const cols: Record<string, SqlValue> = { updated_at: updatedAt }
  if (patch.status !== undefined) cols.status = patch.status
  if (patch.pointsAwarded !== undefined) cols.points_awarded = patch.pointsAwarded
  if (patch.completedAt !== undefined) cols.completed_at = patch.completedAt
  if (patch.note !== undefined) cols.note = patch.note

  const { clause, values } = buildSetClause(cols)
  const changes = getDb()
    .prepare(`UPDATE task_occurrences SET ${clause} WHERE id = ?`)
    .run(...values, id).changes
  if (changes === 0) throw appError('NOT_FOUND', '打卡记录不存在', { detail: `id=${id}` })
  return requireById(id)
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM task_occurrences').get() as { n: number }
  return row.n
}

export function countByTask(taskId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM task_occurrences WHERE task_id = ?')
    .get(taskId) as { n: number }
  return row.n
}

/** 昨日及更早仍未完成的 pending → missed（01 §2.1.3 的调度器规则，数据层只提供批量写） */
export function markMissedBefore(day: string, updatedAt: string): number {
  return getDb()
    .prepare(
      `UPDATE task_occurrences SET status = 'missed', updated_at = ?
       WHERE day < ? AND status = 'pending'`
    )
    .run(updatedAt, day).changes
}
