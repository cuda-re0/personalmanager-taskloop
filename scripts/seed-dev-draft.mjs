#!/usr/bin/env node
/**
 * W5 开发造数：往**开发库**插一条 kind='task_draft' 的真 meta_json 消息，
 * 供端到端手点（kickoff/09：seed 一条草稿 → 点确认 → 卡片已确认态 + 右栏立刻出现）。
 *
 * 运行方式（better-sqlite3 被 electron-rebuild 编成 Electron ABI，系统 node 加载不了）：
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/seed-dev-draft.mjs
 *
 * 库路径 = Electron userData/taskloop.db（Windows 默认 %APPDATA%/taskloop/taskloop.db），
 * 可用第一个命令行参数覆盖。脚本只 INSERT 消息行，不碰 tasks / occurrences。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

let Database
try {
  // better-sqlite3 是 CJS：module.exports 本身就是 Database 类
  Database = require('better-sqlite3')
} catch (e) {
  console.error('[seed] 加载 better-sqlite3 失败：', e.message)
  console.error('[seed] 请用 Electron 内置 node 运行本脚本（见文件头注释）。')
  process.exit(1)
}

const file = process.argv[2] || join(process.env.APPDATA || '.', 'taskloop', 'taskloop.db')

let db
try {
  db = new Database(file, { timeout: 5000 })
  db.pragma('journal_mode = WAL')
} catch (e) {
  console.error(`[seed] 打不开数据库 ${file}：`, e.message)
  process.exit(1)
}

// 库必须先由应用迁移出来（npm run dev 启动一次即可）；本脚本不做迁移
const hasMessages = db
  .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='messages'")
  .get()
if (!hasMessages || hasMessages.n === 0) {
  console.error(`[seed] ${file} 里没有 messages 表：先启动一次应用（npm run dev）建库，再跑本脚本。`)
  db.close()
  process.exit(1)
}

const now = new Date().toISOString()
// dueHint 是完整 ISO8601 UTC（02 §1），放到 3 天后 18:00 本地 = 10:00 UTC
const due = new Date(Date.now() + 3 * 86400000)
due.setUTCHours(10, 0, 0, 0)

/** meta_json 里的 draft 必须是完整 TaskDraft 形状（02 §2），分值按口径预填 */
const draft = {
  localId: 'seed-draft-1',
  type: 'deadline',
  title: '写季度复盘初稿',
  detailMd: '整理本季度的三个里程碑与遗留问题，导出 PDF。',
  difficulty: 'medium',
  estimateMin: 60,
  dueHint: due.toISOString(),
  dailyTimeHint: null,
  activeToHint: null,
  reminderOffsets: [-1440, -60],
  tags: ['复盘'],
  steps: [
    { localId: 'seed-step-1', title: '列出三个里程碑', estimateMin: 20, done: false },
    { localId: 'seed-step-2', title: '导出 PDF', estimateMin: 10, done: false }
  ],
  missingInfo: [],
  requiresEvidence: true,
  confidence: 0.82,
  // medium = 20（DEFAULT_CONFIG；本脚本不读 settings，开发库默认档就是 20）
  pointsPlanned: 20
}

const insert = db.prepare(
  `INSERT INTO messages (id, thread_id, role, kind, content_md, meta_json, linked_task_id, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, NULL, 'sent', ?)`
)

const userId = `seed-user-${Date.now().toString(36)}`
const draftId = `seed-draft-msg-${Date.now().toString(36)}`

db.transaction(() => {
  insert.run(userId, 'main', 'user', 'text', '帮我排一下季度复盘。', JSON.stringify({ kind: 'none' }), now)
  insert.run(
    draftId,
    'main',
    'assistant',
    'task_draft',
    '',
    JSON.stringify({ kind: 'task_draft', drafts: [draft] }),
    new Date(Date.now() + 1).toISOString()
  )
})()

console.log(`[seed] 库：${file}`)
console.log(`[seed] 已插入 task_draft 消息 id=${draftId}（localId=${draft.localId}）`)
console.log('[seed] 启动 npm run dev 后确认这张卡片，任务应出现在右栏「限时」组。')
db.close()
