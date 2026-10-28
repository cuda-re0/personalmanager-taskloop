import type { DayIndexEntry, DayStat, DayTaskItem } from '../../../shared/types/domain'
import { roundPoints } from '../../../shared/points/rubric'
import { getDb, tx } from '../connection'
import { appError } from '../errors'
import { isoToLocalDay, isoToLocalTime, monthBounds, assertDay } from '../localDay'
import { DAY_STAT_COLUMNS, emptyDayStat, mapDayStat } from '../mappers'
import type { DayStatRow } from '../mappers'

/**
 * daily_stats（物化聚合）+ 日历查询。
 *
 * `daily_stats` 是可重建的缓存：只在 pointsService / taskService / occurrenceService 的**同一个事务**里 upsert，
 * 任何时候都能用 `rebuildDailyStats()` 从 ledger + tasks + occurrences 全量重算（01 §2.6）。
 *
 * 日历红点按 01 §4.1 的唯一实现走 SQL，一次查完一个月；`date(due_at,'localtime')` 是文档明列的例外
 * （必须显式带 'localtime'，否则东八区 08:00 前的任务会串到前一天）。
 */

const SELECT_DAY_STAT = `SELECT ${DAY_STAT_COLUMNS.join(', ')} FROM daily_stats`

export function getDay(day: string): DayStat {
  assertDay(day)
  const row = getDb().prepare(`${SELECT_DAY_STAT} WHERE day = ?`).get(day) as DayStatRow | undefined
  return row ? mapDayStat(row) : emptyDayStat(day)
}

/** 日历一个月：没数据的日期不返回，渲染层按缺失=无红点处理 */
export function monthStats(year: number, month: number): DayStat[] {
  const { from, to } = monthBounds(year, month)
  return (getDb()
    .prepare(`${SELECT_DAY_STAT} WHERE day >= ? AND day <= ? ORDER BY day ASC`)
    .all(from, to) as DayStatRow[]).map(mapDayStat)
}

/**
 * 加分并 upsert 当日聚合。必须在调用方的事务里执行（和 ledger 插入同生共死）。
 * 累加前过 `roundPoints`：`SUM` 是浮点累加，不收敛就会出现 319.99999999999994（08 DELTA · D1）。
 */
export function addPoints(day: string, delta: number): void {
  const current = getDay(day)
  const next = roundPoints(current.points + delta)
  getDb()
    .prepare(
      `INSERT INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET points = excluded.points`
    )
    .run(day, next, current.tasksDone, current.tasksCreated, current.occurrencesDone)
}

export function bumpTasksCreated(day: string, n = 1): void {
  bumpCounter(day, 'tasks_created', n)
}

export function bumpTasksDone(day: string, n = 1): void {
  bumpCounter(day, 'tasks_done', n)
}

export function bumpOccurrencesDone(day: string, n = 1): void {
  bumpCounter(day, 'occurrences_done', n)
}

function bumpCounter(day: string, column: 'tasks_created' | 'tasks_done' | 'occurrences_done', n: number): void {
  getDb()
    .prepare(
      `INSERT INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, 0, 0, 0, 0)
       ON CONFLICT(day) DO UPDATE SET ${column} = daily_stats.${column} + ?`
    )
    .run(day, n)
}

/* ------------------------------------------------------------------ *
 * 日历（calendarService 的唯一数据源；W6B / W2 直接调这两个函数）
 * ------------------------------------------------------------------ */

export function dayIndex(from: string, to: string): DayIndexEntry[] {
  assertDay(from, '起始日')
  assertDay(to, '结束日')
  if (from > to) throw appError('INVALID_INPUT', '日期区间起点晚于终点', { detail: `${from} > ${to}` })
  const rows = getDb()
    .prepare(
      `SELECT date(due_at, 'localtime') AS day,
              COUNT(*)                                        AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count
       FROM tasks
       WHERE type IN ('deadline','event')
         AND due_at IS NOT NULL
         AND date(due_at, 'localtime') BETWEEN ? AND ?
         AND status NOT IN ('discarded','archived')
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(from, to) as { day: string; total: number; done_count: number }[]
  return rows.map(r => ({ day: r.day, total: r.total, doneCount: r.done_count }))
}

export function dayDetail(day: string): DayTaskItem[] {
  assertDay(day)
  const rows = getDb()
    .prepare(
      `SELECT id, type, title, due_at, status, points_awarded, points_planned
       FROM tasks
       WHERE type IN ('deadline','event')
         AND due_at IS NOT NULL
         AND date(due_at, 'localtime') = ?
         AND status NOT IN ('discarded','archived')
       ORDER BY due_at ASC, sort_key ASC`
    )
    .all(day) as {
    id: string
    type: 'deadline' | 'event'
    title: string
    due_at: string
    status: 'todo' | 'doing' | 'reviewing' | 'done'
    points_awarded: number | null
    points_planned: number
  }[]

  return rows.map(r => ({
    taskId: r.id,
    type: r.type,
    title: r.title,
    time: isoToLocalTime(r.due_at),
    dueAt: r.due_at,
    status: r.status,
    // 未完成的条目显示计划分，完成的显示实得分
    points: r.points_awarded ?? r.points_planned
  }))
}

/* ------------------------------------------------------------------ *
 * 兜底重算
 * ------------------------------------------------------------------ */

/**
 * 从 point_ledger + tasks + task_occurrences 全量重算 daily_stats。
 * 用于兜底与验证（01 §2.6）。全部在一个事务里做「清空 → 重写」，中途失败不会留下半张表。
 *
 * 注意：`day` 一律用 localDay.ts 在 JS 里算，**不用** SQLite 的 `date(...,'localtime')`
 * 参与写库路径（避免同一份数据两种算法）。
 */
export function rebuildDailyStats(): { days: number } {
  const db = getDb()

  const ledgerRows = db.prepare('SELECT day, delta FROM point_ledger').all() as {
    day: string
    delta: number
  }[]
  const taskRows = db
    .prepare('SELECT created_at, completed_at, status FROM tasks')
    .all() as { created_at: string; completed_at: string | null; status: string }[]
  const occurrenceRows = db
    .prepare("SELECT day FROM task_occurrences WHERE status = 'done'")
    .all() as { day: string }[]

  const acc = new Map<string, DayStat>()

  const bucket = (day: string): DayStat => {
    let stat = acc.get(day)
    if (!stat) {
      stat = emptyDayStat(day)
      acc.set(day, stat)
    }
    return stat
  }

  for (const row of ledgerRows) {
    const stat = bucket(row.day)
    stat.points = roundPoints(stat.points + row.delta)
  }

  for (const row of taskRows) {
    bucket(isoToLocalDay(row.created_at)).tasksCreated += 1
    if (row.status === 'done' && row.completed_at) {
      bucket(isoToLocalDay(row.completed_at)).tasksDone += 1
    }
  }

  for (const row of occurrenceRows) {
    bucket(row.day).occurrencesDone += 1
  }

  const days = [...acc.values()].sort((a, b) => (a.day < b.day ? -1 : 1))

  tx(() => {
    db.prepare('DELETE FROM daily_stats').run()
    const stmt = db.prepare(
      `INSERT INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const d of days) {
      stmt.run(d.day, d.points, d.tasksDone, d.tasksCreated, d.occurrencesDone)
    }
  })

  return { days: days.length }
}

export function countDays(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM daily_stats').get() as { n: number }
  return row.n
}
