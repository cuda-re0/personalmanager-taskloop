import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, tx } from '../../src/main/db/connection'
import { addDays, isoToLocalDay, monthBounds, todayLocalDay } from '../../src/main/db/localDay'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskService from '../../src/main/services/taskService'
import { openTempFileDb } from './helpers'
/**
 * 性能验收：1000 任务 + 5000 流水 + 3000 occurrence 下，
 * task.list / calendar.dayIndex / points.monthStats 各 < 20ms。
 *
 * 用**临时文件库**而不是 :memory:，因为 WAL + 磁盘 IO 才是用户实际遇到的情况。
 * 计时取 5 次里的最快一次（暖缓存），并在 stdout 打出每次的实测值，便于交付说明里引用。
 */

const TASK_COUNT = 1000
const LEDGER_COUNT = 5000
const OCCURRENCE_COUNT = 3000

interface Timing {
  name: string
  best: number
  all: number[]
}

function measure(name: string, runs: number, fn: () => void): Timing {
  fn() // 预热：让 better-sqlite3 编译好语句
  const all: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    fn()
    all.push(performance.now() - start)
  }
  return { name, best: Math.min(...all), all }
}

function report(t: Timing): void {
  const formatted = t.all.map(v => v.toFixed(2)).join(' / ')
  console.log(`[perf] ${t.name}: best ${t.best.toFixed(2)}ms (runs: ${formatted})`)
}

function seed(): void {
  const db = getDb()
  const today = todayLocalDay()
  const now = '2026-10-28T02:00:00.000Z'

  tx(() => {
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, type, status, title, detail_md, parent_id, sort_key, priority, difficulty,
        estimate_min, due_at, daily_time, repeat_rule, active_from, active_to,
        reminder_offsets_json, reminder_channels_json, tags_json, points_planned, points_awarded, quality,
        requires_evidence, evidence_json, streak_current, streak_best, source, ai_confidence,
        created_at, updated_at, started_at, completed_at, archived_at)
       VALUES (?, ?, ?, ?, '', NULL, ?, 0, 'medium', 60, ?, ?, ?, ?, ?, '[]', '["inapp"]',
        '["工作"]', 23, ?, ?, 0, '[]', 0, 0, 'chat', NULL, ?, ?, NULL, ?, NULL)`
    )

    const statuses = ['todo', 'doing', 'reviewing', 'done', 'archived']
    const types = ['deadline', 'event', 'daily']
    for (let i = 0; i < TASK_COUNT; i += 1) {
      const type = types[i % types.length]
      const status = type === 'daily' ? (i % 4 === 0 ? 'doing' : 'todo') : statuses[i % statuses.length]
      const dueDay = addDays(today, (i % 60) - 30)
      const dueAt = type === 'daily' ? null : `${dueDay}T09:00:00.000Z`
      insertTask.run(
        `perf-task-${String(i).padStart(4, '0')}`,
        type,
        status,
        `性能任务 ${i}`,
        i,
        dueAt,
        type === 'daily' ? '21:00' : null,
        type === 'daily' ? 'DAILY' : null,
        type === 'daily' ? '2026-01-01' : null,
        null,
        status === 'done' ? 23 : null,
        status === 'done' ? 'met' : null,
        now,
        now,
        status === 'done' ? now : null
      )
    }

    const insertLedger = db.prepare(
      `INSERT INTO point_ledger (id, task_id, occurrence_id, delta, kind, reason_code, reason_text, day, created_at)
       VALUES (?, NULL, NULL, ?, 'award', 'manual_adjust', '性能样本', ?, ?)`
    )
    for (let i = 0; i < LEDGER_COUNT; i += 1) {
      const day = addDays(today, -Math.floor(i / 100))
      insertLedger.run(`perf-ledger-${String(i).padStart(4, '0')}`, 1.25, day, `${day}T03:00:00.000Z`)
    }

    const dailyTaskIds = (
      db.prepare("SELECT id FROM tasks WHERE type = 'daily' LIMIT 40").all() as { id: string }[]
    ).map(r => r.id)
    const insertOcc = db.prepare(
      `INSERT OR IGNORE INTO task_occurrences (id, task_id, day, status, points_awarded, completed_at, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    for (let i = 0; i < OCCURRENCE_COUNT; i += 1) {
      // (task, day) 组合必须唯一，否则会被 uq_occurrence_task_day 静默忽略：
      // 40 个任务 × 75 天 = 3000 条
      const taskId = dailyTaskIds[i % dailyTaskIds.length]
      const day = addDays(today, -Math.floor(i / dailyTaskIds.length))
      // 1/3 已完成，让 occurrences_done / streak 这类聚合也有真实数据
      const done = i % 3 === 0
      insertOcc.run(
        `perf-occ-${String(i).padStart(4, '0')}`,
        taskId,
        day,
        done ? 'done' : 'pending',
        done ? 1 : null,
        done ? `${day}T13:00:00.000Z` : null,
        now,
        now
      )
    }

    const insertStat = db.prepare(
      `INSERT OR REPLACE INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < 90; i += 1) {
      const day = addDays(today, -i)
      insertStat.run(day, 12.5, 2, 1, 1)
    }
  })
}

describe('性能（1000 任务 / 5000 流水 / 3000 occurrence）', () => {
  let cleanup: () => void = () => {}

  beforeEach(() => {
    const opened = openTempFileDb('taskloop-perf')
    cleanup = opened.cleanup
    seed()
  })

  afterEach(() => {
    cleanup()
  })

  it('数据量真的到位了', () => {
    const db = getDb()
    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM tasks')).toBe(TASK_COUNT)
    expect(count('SELECT COUNT(*) AS n FROM point_ledger')).toBe(LEDGER_COUNT)
    expect(count('SELECT COUNT(*) AS n FROM task_occurrences')).toBe(OCCURRENCE_COUNT)
  })

  it('task.list < 20ms', () => {
    const rows = taskService.listTasks({ status: ['todo', 'doing', 'reviewing'] })
    expect(rows.length).toBeGreaterThan(0)
    const timing = measure('task.list', 5, () => {
      taskService.listTasks({ status: ['todo', 'doing', 'reviewing'] })
    })
    report(timing)
    expect(timing.best).toBeLessThan(20)
  })

  it('calendar.dayIndex < 20ms', () => {
    const today = todayLocalDay()
    const { from, to } = monthBounds(Number(today.slice(0, 4)), Number(today.slice(5, 7)))
    expect(statsRepo.dayIndex(from, to).length).toBeGreaterThan(0)

    const timing = measure('calendar.dayIndex', 5, () => {
      statsRepo.dayIndex(from, to)
    })
    report(timing)
    expect(timing.best).toBeLessThan(20)
  })

  it('points.monthStats < 20ms', () => {
    const today = todayLocalDay()
    const year = Number(today.slice(0, 4))
    const month = Number(today.slice(5, 7))
    expect(pointsService.monthStats(year, month).length).toBeGreaterThan(0)

    const timing = measure('points.monthStats', 5, () => {
      pointsService.monthStats(year, month)
    })
    report(timing)
    expect(timing.best).toBeLessThan(20)
  })

  it('余额 SUM（5000 条）也在可接受范围', () => {
    const timing = measure('points.balance', 5, () => {
      pointsService.balance()
    })
    report(timing)
    expect(timing.best).toBeLessThan(20)
    expect(pointsService.balance()).toBeCloseTo(LEDGER_COUNT * 1.25, 6)
  })

  it('重建 90 天聚合 < 200ms（兜底能力）', () => {
    const start = performance.now()
    const result = statsRepo.rebuildDailyStats()
    const elapsed = performance.now() - start
    console.log(`[perf] rebuildDailyStats: ${elapsed.toFixed(2)}ms (${result.days} 天)`)
    expect(result.days).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })

  it('isoToLocalDay 在 5000 次映射里不拖后腿', () => {
    const iso = '2026-10-27T16:30:00.000Z'
    const timing = measure('isoToLocalDay x5000', 3, () => {
      for (let i = 0; i < 5000; i += 1) isoToLocalDay(iso)
    })
    report(timing)
    expect(timing.best).toBeLessThan(100)
  })
})
