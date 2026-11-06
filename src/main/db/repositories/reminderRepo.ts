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

/**
 * 某任务「绝对时间」提醒里最远的 `fire_at`；没有返回 null（81 §3.1）。
 * 只看 active / paused：fired 是历史，不该把补建窗口一直顶在前面。
 */
export function maxActiveAbsoluteFireAt(taskId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(fire_at) AS fire_at FROM reminders
       WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
    )
    .get(taskId) as { fire_at: string | null } | undefined
  return row?.fire_at ?? null
}

/**
 * 重复任务的增量物化（81 §3.1）：清掉换过规则的旧行，再补插计划内缺失的行。
 *
 * 不能复用 `replaceForTask`：它删掉 active/paused/failed 全部行，重复任务每轮补建
 * 都会把用户点过「稍后提醒」（改了 fire_at 但仍是 active）的那条一起抹掉。
 * `fire_at` 已存在的直接跳过，保证 snooze 过的那条留着。
 */
export function ensureRepeatRows(
  taskId: string,
  rule: string,
  clock: string,
  rows: Omit<ReminderInsert, 'taskId'>[]
): Reminder[] {
  tx(() => {
    const db = getDb()
    db.prepare(
      `DELETE FROM reminders
       WHERE task_id = ? AND status IN ('active','paused') AND offset_min IS NULL
         AND (repeat_rule IS NULL OR repeat_rule <> ?)`
    ).run(taskId, rule)

    // 时刻整体改过 → 现有行没有一条落在目标 clock，全删交给下面的补插重建。
    // 判「一条都不匹配」而不是逐条比对：snooze 过的那条会偏离 clock，但同批必有别的行匹配，
    // 逐条比对会把这条 snooze 抹掉。
    const absolute = db
      .prepare(
        `SELECT fire_at FROM reminders
         WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
      )
      .all(taskId) as { fire_at: string }[]
    if (absolute.length > 0) {
      const hasClock = absolute.some(row => {
        const at = new Date(row.fire_at)
        const hh = String(at.getHours()).padStart(2, '0')
        const mm = String(at.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}` === clock
      })
      if (!hasClock) {
        db.prepare(
          `DELETE FROM reminders
           WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
        ).run(taskId)
      }
    }

    const existing = new Set(
      (
        db.prepare(
          `SELECT fire_at FROM reminders
           WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
        ).all(taskId) as { fire_at: string }[]
      ).map(row => row.fire_at)
    )

    const insertSql = `INSERT INTO reminders (${REMINDER_COLUMNS.join(', ')})
       VALUES (${placeholders(REMINDER_COLUMNS.length)})`
    for (const row of rows) {
      if (existing.has(row.fireAt)) continue
      db.prepare(insertSql).run(...reminderInsertParams({ ...row, taskId }))
      existing.add(row.fireAt)
    }
  })
  return listByTask(taskId)
}

/**
 * 删任务时清掉它还没触发的提醒行（v0.85b）：只删 active / paused。
 * fired 是历史（会话区已写过消息，行是对账凭据），failed / cancelled 是终态，一律保留。
 * 不包 `wrapWriteError`：只在 `taskService.removeTask` 的事务内调用，由外层事务统一翻译错误。
 */
export function removePendingByTask(taskId: string): number {
  return getDb()
    .prepare("DELETE FROM reminders WHERE task_id = ? AND status IN ('active','paused')")
    .run(taskId).changes
}

/**
 * 清掉「所属任务已丢弃 / 已归档」的残留提醒行（v0.85b）。软删不触发外键级联，
 * 历史遗留的 active 行只能这样收口。`task_id IS NULL` 的脏数据不归本函数管。
 */
export function purgeForInactiveTasks(): number {
  return getDb()
    .prepare(
      `DELETE FROM reminders
       WHERE status IN ('active','paused')
         AND task_id IN (SELECT id FROM tasks WHERE status IN ('discarded','archived'))`
    )
    .run().changes
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
