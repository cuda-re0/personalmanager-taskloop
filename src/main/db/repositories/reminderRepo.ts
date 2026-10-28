import type { NotifyChannel, Reminder } from '../../../shared/types/domain'
import { getDb, tx } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { REMINDER_COLUMNS, mapReminder, reminderInsertParams } from '../mappers'
import type { ReminderInsert, ReminderRow } from '../mappers'
import { placeholders } from '../sqlUtil'

/**
 * reminders 的数据访问层。
 * 这张表是 `tasks.reminder_offsets_json` 的**物化结果**，不是独立真相（01 §2.5）：
 * 任务新建/改时调用 `replaceForTask()` 整体重建，`uq_reminder_task_offset` 兜住重复 sync。
 */

const SELECT_REMINDER = `SELECT ${REMINDER_COLUMNS.join(', ')} FROM reminders`

export function listByTask(taskId: string): Reminder[] {
  return (getDb()
    .prepare(`${SELECT_REMINDER} WHERE task_id = ? ORDER BY fire_at ASC`)
    .all(taskId) as ReminderRow[]).map(mapReminder)
}

export function listUpcoming(limit = 20): Reminder[] {
  return (getDb()
    .prepare(
      `${SELECT_REMINDER} WHERE status = 'active' ORDER BY fire_at ASC LIMIT ?`
    )
    .all(limit) as ReminderRow[]).map(mapReminder)
}

export function listDue(nowIsoText: string, limit = 50): Reminder[] {
  return (getDb()
    .prepare(
      `${SELECT_REMINDER} WHERE status = 'active' AND fire_at <= ?
       ORDER BY fire_at ASC LIMIT ?`
    )
    .all(nowIsoText, limit) as ReminderRow[]).map(mapReminder)
}

export function getById(id: string): Reminder | null {
  const row = getDb().prepare(`${SELECT_REMINDER} WHERE id = ?`).get(id) as ReminderRow | undefined
  return row ? mapReminder(row) : null
}

export function requireById(id: string): Reminder {
  const reminder = getById(id)
  if (!reminder) throw appError('NOT_FOUND', '提醒不存在', { detail: `id=${id}` })
  return reminder
}

export function insert(input: ReminderInsert): Reminder {
  try {
    getDb()
      .prepare(
        `INSERT INTO reminders (${REMINDER_COLUMNS.join(', ')})
         VALUES (${placeholders(REMINDER_COLUMNS.length)})`
      )
      .run(...reminderInsertParams(input))
  } catch (e) {
    throw wrapWriteError(e, '提醒写入失败（同一任务同一偏移已存在）')
  }
  return requireById(input.id)
}

/**
 * 按任务整体重建：删掉未触发的旧行 → 插入新行。一个事务，外面看不到中间状态。
 * 已 fired 的行保留（历史），cancelled 的行保留（唯一索引把它们排除在外）。
 */
export function replaceForTask(taskId: string, rows: Omit<ReminderInsert, 'taskId'>[]): Reminder[] {
  tx(() => {
    const db = getDb()
    db.prepare(
      `DELETE FROM reminders WHERE task_id = ? AND status IN ('active','paused','failed')`
    ).run(taskId)
    for (const row of rows) {
      db.prepare(
        `INSERT INTO reminders (${REMINDER_COLUMNS.join(', ')})
         VALUES (${placeholders(REMINDER_COLUMNS.length)})`
      ).run(...reminderInsertParams({ ...row, taskId }))
    }
  })
  return listByTask(taskId)
}

export function cancel(id: string): void {
  const changes = getDb()
    .prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status != 'fired'")
    .run(id).changes
  if (changes === 0) {
    // 已经 fired 的不允许取消（提醒已经发生过了），但不能静默成功
    requireById(id)
    throw appError('CONFLICT', '这条提醒已经触发，无法取消', { detail: `id=${id}` })
  }
}

export function snooze(id: string, fireAt: string): Reminder {
  const changes = getDb()
    .prepare("UPDATE reminders SET fire_at = ?, status = 'active' WHERE id = ?")
    .run(fireAt, id).changes
  if (changes === 0) throw appError('NOT_FOUND', '提醒不存在', { detail: `id=${id}` })
  return requireById(id)
}

export function markFired(id: string, channels: NotifyChannel[], firedAt: string): Reminder {
  const changes = getDb()
    .prepare(
      `UPDATE reminders
       SET status = 'fired', last_fired_at = ?, fired_channels_json = ?
       WHERE id = ?`
    )
    .run(firedAt, JSON.stringify(channels), id).changes
  if (changes === 0) throw appError('NOT_FOUND', '提醒不存在', { detail: `id=${id}` })
  return requireById(id)
}

export function markFailed(id: string, reason: string): Reminder {
  const changes = getDb()
    .prepare("UPDATE reminders SET status = 'failed', fail_reason = ? WHERE id = ?")
    .run(reason, id).changes
  if (changes === 0) throw appError('NOT_FOUND', '提醒不存在', { detail: `id=${id}` })
  return requireById(id)
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number }
  return row.n
}
