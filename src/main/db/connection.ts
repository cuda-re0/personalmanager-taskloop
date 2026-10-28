import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { MIGRATIONS } from './migrations'
import { nowIso } from './localDay'
import { appError, wrapWriteError } from './errors'

/**
 * 单例连接 + 迁移。
 *
 * pragma 四行的顺序与理由（01 §2.0 + 08 DELTA 的裁决）：
 *   journal_mode = WAL     → 写进库文件，持久生效；只有在建库/切模式时才起作用
 *   synchronous = NORMAL   → 连接级，**每次 new Database 都要重设**
 *   foreign_keys = ON      → 连接级，同上（SQLite 默认是 OFF，漏了级联删除就是假的）
 *   busy_timeout = 5000    → 连接级，避免与外部工具抢锁时立刻抛 SQLITE_BUSY
 * 所以 applyPragmas() 在 openDb() 里对**每一个**新连接都跑一遍，而不是只在初始化新库时跑。
 *
 * 迁移版本以 `PRAGMA user_version` 为权威（01 §5，commit c9861b0 的裁决）；
 * `schema_meta` 只记历史明细（key=`migration.<name>`，value=应用时刻 ISO），不参与版本判定。
 */

export type Db = Database.Database

/** 当前连接。测试里用 openDb() 反复开关，生产只开一次。 */
let current: Db | null = null

const PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000'
] as const

export function applyPragmas(db: Db): void {
  for (const p of PRAGMAS) db.pragma(p)
}

export function getUserVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

/**
 * 按 user_version 顺序执行未应用的迁移，每个版本一个事务。
 * 返回迁移后的版本号。
 */
export function migrate(db: Db): number {
  const applied = getUserVersion(db)
  const target = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

  if (applied > target) {
    // 库比应用新：降级会丢列、丢索引，宁可直接失败
    throw appError('DB_ERROR', '数据库版本高于当前应用，请升级应用后再打开', {
      detail: `user_version=${applied} > 应用最高迁移 ${target}`
    })
  }

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= applied) continue
    const run = db.transaction(() => {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
      db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(`migration.${migration.name}`, nowIso())
    })
    try {
      run()
    } catch (e) {
      throw wrapWriteError(e, `迁移 ${migration.name} 执行失败`)
    }
  }

  return getUserVersion(db)
}

export function openDb(file: string): Db {
  if (current) closeDb()
  let db: Db
  try {
    db = new Database(file)
  } catch (e) {
    throw wrapWriteError(e, `无法打开数据库 ${file}`)
  }
  applyPragmas(db)
  migrate(db)
  current = db
  return db
}

/**
 * 生产入口，由 `src/main/index.ts` 调用（函数签名不能改，那个文件不归 W1）。
 * 只在这里碰 electron：数据库层其余代码不依赖 electron，测试可以直接 openDb(':memory:')。
 */
export function initDb(file?: string): void {
  if (file) {
    openDb(file)
    return
  }
  if (!app || typeof app.getPath !== 'function') {
    throw appError('DB_ERROR', '无法解析用户数据目录（非 Electron 环境请显式传入数据库路径）')
  }
  const dir = app.getPath('userData')
  mkdirSync(dirname(join(dir, 'taskloop.db')), { recursive: true })
  openDb(join(dir, 'taskloop.db'))
}

export function getDb(): Db {
  if (!current) {
    throw appError('DB_ERROR', '数据库尚未初始化', { detail: '先调用 initDb() 或 openDb()' })
  }
  return current
}

export function isOpen(): boolean {
  return current !== null && current.open
}

export function closeDb(): void {
  if (current) {
    current.close()
    current = null
  }
}

/**
 * 事务封装，透传 `db.transaction`（better-sqlite3 是同步的，传 async 函数会静默失效，
 * 所以这里显式挡掉 Promise，避免"事务里 await 了一下"导致三张表没在一个事务里）。
 */
export function tx<T>(fn: () => T): T {
  const db = getDb()
  const wrapped = db.transaction(() => {
    const result = fn()
    if (result instanceof Promise) {
      throw appError('DB_ERROR', '事务回调不能是 async 函数', {
        detail: 'better-sqlite3 的事务是同步的，请把 await 移到 tx() 外面'
      })
    }
    return result
  })
  try {
    return wrapped()
  } catch (e) {
    throw wrapWriteError(e, '数据库事务失败')
  }
}
