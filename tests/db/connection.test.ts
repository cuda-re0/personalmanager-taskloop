import { describe, expect, it } from 'vitest'
import { getDb, getUserVersion, migrate, tx } from '../../src/main/db/connection'
import { closeTestDb, openMemoryDb, openTempFileDb } from './helpers'

describe('connection / 迁移', () => {
  it('四条 pragma 按约定生效（文件库才能看到 WAL）', () => {
    const { cleanup } = openTempFileDb('taskloop-pragma')
    try {
      const db = getDb()
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      // synchronous: NORMAL = 1，FULL = 2
      expect(db.pragma('synchronous', { simple: true })).toBe(1)
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    } finally {
      cleanup()
    }
  })

  it('迁移用 user_version 记版本，schema_meta 只记明细', () => {
    openMemoryDb()
    try {
      const db = getDb()
      // v0.49 起多一条 005_attachment_name；v0.73 起多一条 006_message_mode；
      // v0.88 起多一条 008_alert；v0.92 起多一条 009_message_settled；
      // v0.93 起多一条 010_task_planned_day
      expect(getUserVersion(db)).toBe(10)

      for (const name of ['migration.001_init', 'migration.002_ledger_reversed']) {
        const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(name) as
          | { value: string }
          | undefined
        expect(row, `${name} 应记入 schema_meta`).toBeDefined()
        expect(row?.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      }
    } finally {
      closeTestDb()
    }
  })

  it('重复 migrate 不会重复建表、版本不前进', () => {
    openMemoryDb()
    try {
      const db = getDb()
      // 再次跑一遍迁移等价于生产重启路径：已应用的版本必须跳过
      expect(migrate(db)).toBe(10)
      expect(getUserVersion(db)).toBe(10)
    } finally {
      closeTestDb()
    }
  })

  it('建库后七张表与三条唯一索引都在', () => {
    openMemoryDb()
    try {
      const db = getDb()
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      ).map(r => r.name)
      for (const t of [
        'schema_meta',
        'tasks',
        'task_occurrences',
        'messages',
        'attachments',
        'point_ledger',
        'reminders',
        'daily_stats',
        'settings'
      ]) {
        expect(tables).toContain(t)
      }

      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map(r => r.name)
      expect(indexes).toContain('uq_ledger_task_done')
      expect(indexes).toContain('uq_ledger_occurrence')
      expect(indexes).toContain('uq_occurrence_task_day')

      // 第一条必须是带 occurrence_id IS NULL 的条件索引，否则每日任务第 2 天会被拒
      const sql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'uq_ledger_task_done'")
          .get() as { sql: string }
      ).sql
      expect(sql).toContain('WHERE reason_code = \'task_done\' AND occurrence_id IS NULL')

      // v0.19：谓词必须带 reversed_at IS NULL，否则撤销后重做会撞索引（tests/db/undoRedo.test.ts）
      expect(sql).toContain('reversed_at IS NULL')
      const occSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'uq_ledger_occurrence'")
          .get() as { sql: string }
      ).sql
      expect(occSql).toContain('reversed_at IS NULL')
    } finally {
      closeTestDb()
    }
  })

  it('tx 回滚：中途抛错后两张表都不留痕', () => {
    openMemoryDb()
    try {
      const db = getDb()
      const before = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
      expect(() =>
        tx(() => {
          db.prepare(
            `INSERT INTO tasks (id, type, status, title, created_at, updated_at)
             VALUES ('t1','deadline','todo','回滚用','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z')`
          ).run()
          throw new Error('boom')
        })
      ).toThrow()
      const after = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
      expect(after).toBe(before)
    } finally {
      closeTestDb()
    }
  })
})
