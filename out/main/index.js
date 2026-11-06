"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_fs = require("node:fs");
const Database = require("better-sqlite3");
const node_path = require("node:path");
const node_crypto = require("node:crypto");
const zod = require("zod");
const node_child_process = require("node:child_process");
const node_http = require("node:http");
const initSql = `-- 001_init.sql — 首次建库。
-- 内容逐字来自 docs/01-DATA-MODEL.md §2（按 §2 的说明删除了 ★ 标记及其后空格）。
-- 文档 §2.0 的四条 PRAGMA 不写在本文件里：journal_mode / synchronous 不能在事务内设置，
-- 且 synchronous / foreign_keys / busy_timeout 是连接级设置，每次 new Database 都要重设。
-- 四条 pragma 由 src/main/db/connection.ts 的 applyPragmas() 负责，顺序：
--   journal_mode = WAL → synchronous = NORMAL → foreign_keys = ON → busy_timeout = 5000

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,               -- nanoid(12)
  type            TEXT NOT NULL DEFAULT 'deadline', -- daily|deadline|event
  status          TEXT NOT NULL,                  -- 见 §3 状态机
  title           TEXT NOT NULL,                  -- ≤ 40 字，动词开头
  detail_md       TEXT NOT NULL DEFAULT '',       -- AI 补全后的可执行描述
  parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  sort_key        REAL NOT NULL DEFAULT 0,        -- 同级排序，插入取中值避免重排
  priority        INTEGER NOT NULL DEFAULT 0,     -- 0 普通 / 1 高 / 2 紧急
  difficulty      TEXT NOT NULL DEFAULT 'easy',   -- trivial|easy|medium|hard|epic
  estimate_min    INTEGER,                        -- 预估分钟。v0.9 起不进积分公式，只用于判难度/排提醒/算逾期

  -- 时间语义按 type 解释，见 §2.1.1
  due_at          TEXT,                           -- deadline: 截止时刻 / event: 发生时刻 / daily: NULL
  daily_time      TEXT,                           -- daily: 'HH:mm'，每日提醒时刻
  repeat_rule     TEXT,                           -- daily: 'DAILY' | 'WEEKLY:1,3,5' | NULL=每天
  active_from     TEXT,                           -- daily: 起始日 YYYY-MM-DD
  active_to       TEXT,                           -- daily: 结束日，NULL=长期

  reminder_offsets_json TEXT NOT NULL DEFAULT '[]', -- 分钟偏移，负数表示提前，见 §2.1.2
  reminder_channels_json TEXT NOT NULL DEFAULT '["inapp"]', -- inapp|toast|mail|webhook

  tags_json       TEXT NOT NULL DEFAULT '[]',
  points_planned  REAL NOT NULL DEFAULT 0,        -- 单次应得分（daily 为单日分值），2 位小数
  points_awarded  REAL,                           -- 限时/活动：实际入账；daily 恒为 NULL（看 occurrences）
  quality         TEXT,                           -- partial|met|exceeded

  requires_evidence INTEGER NOT NULL DEFAULT 0,   -- 1 = 完成时必须附证据才计分（S4 已定）
  evidence_json   TEXT NOT NULL DEFAULT '[]',     -- Evidence[]：文字说明或附件 id
  streak_current  INTEGER NOT NULL DEFAULT 0,     -- daily 专用：当前连续天数
  streak_best     INTEGER NOT NULL DEFAULT 0,     -- daily 专用：历史最佳
  source          TEXT NOT NULL DEFAULT 'chat',    -- chat|manual|hud
  ai_confidence   REAL,                           -- 0~1，低于 0.5 时 UI 提示需核
  ai_proposal_json TEXT,                          -- AI 原始提案，供追溯
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  archived_at     TEXT
);

CREATE INDEX idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX idx_tasks_type_status ON tasks(type, status);
CREATE INDEX idx_tasks_parent     ON tasks(parent_id);
CREATE INDEX idx_tasks_completed  ON tasks(completed_at);
CREATE INDEX idx_tasks_status_sort ON tasks(status, sort_key);

CREATE TABLE task_occurrences (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,                -- YYYY-MM-DD 本地日
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|done|skipped|missed
  points_awarded REAL,                         -- 2 位小数，单日实得
  completed_at   TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_occurrence_task_day ON task_occurrences(task_id, day);
CREATE INDEX idx_occurrence_day  ON task_occurrences(day);
CREATE INDEX idx_occurrence_done ON task_occurrences(day, status);

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL DEFAULT 'main',
  role           TEXT NOT NULL,                -- user|assistant|system
  kind           TEXT NOT NULL,                -- text|task_draft|task_review|reminder|error
  content_md     TEXT NOT NULL DEFAULT '',     -- 气泡正文（markdown）
  meta_json      TEXT NOT NULL DEFAULT '{}',   -- 卡片数据：草稿数组 / 审核结论 / 提醒载荷
  linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'sent', -- pending|streaming|sent|failed
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  latency_ms     INTEGER,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
  kind       TEXT NOT NULL,               -- image|file
  rel_path   TEXT NOT NULL,               -- 相对 userData/attachments/
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  sha256     TEXT NOT NULL,               -- 去重 + 完整性校验
  created_at TEXT NOT NULL
);

CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_sha     ON attachments(sha256);

CREATE TABLE point_ledger (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  occurrence_id TEXT REFERENCES task_occurrences(id) ON DELETE SET NULL,
  delta         REAL NOT NULL,              -- 正为得，负为扣；2 位小数，不做整数化
  kind          TEXT NOT NULL,              -- award|penalty|adjust
  reason_code   TEXT NOT NULL,              -- task_done|quality_bonus|overdue_penalty|manual_adjust|streak_bonus
  reason_text   TEXT NOT NULL DEFAULT '',
  day           TEXT NOT NULL,              -- 本地日历日 YYYY-MM-DD，供聚合
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_ledger_day  ON point_ledger(day);
CREATE INDEX idx_ledger_task ON point_ledger(task_id);

-- 限时/活动：一个任务只允许一条「完成发分」，从库层面杜绝重复发分
CREATE UNIQUE INDEX uq_ledger_task_done
  ON point_ledger(task_id)
  WHERE reason_code = 'task_done' AND occurrence_id IS NULL;

-- 每日任务：同一天的这一次只能发一次，不同天各自发
CREATE UNIQUE INDEX uq_ledger_occurrence
  ON point_ledger(occurrence_id)
  WHERE occurrence_id IS NOT NULL;

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  occurrence_id TEXT REFERENCES task_occurrences(id) ON DELETE CASCADE,  -- 每日任务指向当天
  offset_min    INTEGER,                       -- 相对 due_at 的偏移；NULL = 绝对时间
  fire_at       TEXT NOT NULL,
  repeat_rule   TEXT,                          -- NULL=一次性；'DAILY'|'WEEKLY:1,3,5'
  channels_json TEXT NOT NULL DEFAULT '["inapp"]', -- inapp|toast|mail|webhook
  level         TEXT NOT NULL DEFAULT 'normal',    -- normal|strong，见 04 §9
  status        TEXT NOT NULL DEFAULT 'active',-- active|fired|paused|cancelled|failed
  last_fired_at TEXT,
  fired_channels_json TEXT NOT NULL DEFAULT '[]',  -- 已成功送达的渠道，便于补发不重复
  fail_reason   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_reminders_fire ON reminders(status, fire_at);

-- 只约束「当前有效」的提醒：fired / failed 是历史，cancelled 已作废，都不该占唯一位。
-- 否则同一偏移触发过一次后再 syncForTask（改 due_at 导致 fire_at 变化）会插不进去（01 §2.5）。
CREATE UNIQUE INDEX uq_reminder_task_offset
  ON reminders(task_id, offset_min)
  WHERE offset_min IS NOT NULL AND status IN ('active', 'paused');

CREATE TABLE daily_stats (
  day             TEXT PRIMARY KEY,   -- YYYY-MM-DD
  points          REAL NOT NULL DEFAULT 0,     -- 2 位小数，不做整数化
  tasks_done      INTEGER NOT NULL DEFAULT 0,  -- 只算 tasks 表当日 done 数；每日任务看 occurrences_done，不要加进来
  tasks_created   INTEGER NOT NULL DEFAULT 0,
  occurrences_done INTEGER NOT NULL DEFAULT 0  -- 每日任务完成数
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
const ledgerReversedSql = "-- 002_ledger_reversed：撤销后允许重做\n--\n-- 问题（v0.19，W6 审核实测）：\n--   撤销走的是「写一条负的 manual_adjust 行」，原 task_done 行仍留在表里。\n--   两条条件唯一索引都不看「是否已被冲销」，于是重做时新插入的发分行必然撞索引：\n--     task 级：CONFLICT「这个任务已经发过完成分了」\n--     occurrence 级：CONFLICT「这一天的打卡已经发过分了」\n--   每日任务是高频路径，误点一次撤销后当天再也打不上卡。\n--\n-- 修法：\n--   point_ledger 加 reversed_at（被冲销的时刻，NULL = 仍然有效）。\n--   两条唯一索引的谓词都加 `AND reversed_at IS NULL`——它们要约束的是\n--   「同时最多一条有效发分行」，而不是「历史上只许出现一条」。\n--   撤销时把原发分行标上 reversed_at（审计仍能查出哪条被冲了、什么时候冲的），\n--   负流水照写，余额仍是 SUM(delta)。\n--\n-- 注意：索引必须先 DROP 再 CREATE，SQLite 不支持 ALTER INDEX。\n\nALTER TABLE point_ledger ADD COLUMN reversed_at TEXT;\n\nDROP INDEX uq_ledger_task_done;\nCREATE UNIQUE INDEX uq_ledger_task_done\n  ON point_ledger(task_id)\n  WHERE reason_code = 'task_done' AND occurrence_id IS NULL AND reversed_at IS NULL;\n\nDROP INDEX uq_ledger_occurrence;\nCREATE UNIQUE INDEX uq_ledger_occurrence\n  ON point_ledger(occurrence_id)\n  WHERE occurrence_id IS NOT NULL AND reversed_at IS NULL;\n";
const chatSql = "-- 003_chat.sql — 生活助手的三张表（v0.37 · W12）。\n-- 内容逐字来自 docs/01-DATA-MODEL.md §2.8~2.10。\n-- 与 001/002 同一条规矩：迁移不写业务数据（§5）——personas / memories / chat_state\n-- 建成后一行都不预置，人物卡的默认行由 persona.get 就地建（§2.8）。\n\nCREATE TABLE personas (\n  id         TEXT PRIMARY KEY,\n  name       TEXT NOT NULL,                 -- 助手名字，1~20 字\n  user_call  TEXT NOT NULL DEFAULT '',      -- 怎么称呼用户，空串 = 用「你」\n  persona_md TEXT NOT NULL DEFAULT '',      -- 人设正文，≤ 800 字\n  tone       TEXT NOT NULL DEFAULT 'warm',  -- warm|plain|playful\n  is_active  INTEGER NOT NULL DEFAULT 1,    -- 0/1\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n\nCREATE UNIQUE INDEX idx_personas_active ON personas(is_active) WHERE is_active = 1;\n\nCREATE TABLE memories (\n  id         TEXT PRIMARY KEY,\n  content_md TEXT NOT NULL,                 -- 一条一句话，≤ 120 字\n  kind       TEXT NOT NULL,                 -- profile|preference|fact\n  source     TEXT NOT NULL,                 -- auto|manual\n  hits       INTEGER NOT NULL DEFAULT 0,    -- 被带进 system prompt 的次数\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n\nCREATE UNIQUE INDEX idx_memories_content ON memories(content_md);\nCREATE INDEX idx_memories_updated ON memories(updated_at DESC);\n\nCREATE TABLE chat_state (\n  id              TEXT PRIMARY KEY,              -- 恒为 'main'\n  summary_md      TEXT NOT NULL DEFAULT '',      -- 滚动窗口之前的历史摘要，≤ 600 字\n  upto_message_id TEXT,                          -- 摘要已覆盖到哪一条（含）；NULL = 还没摘要过\n  updated_at      TEXT NOT NULL\n);\n";
const spendSql = `-- v0.45 · 零花钱（45 §4.1）
--
-- 1) 流水加两列：只有 kind='spend' 的行有值，其余 NULL（**不塞 0**：
--    0 分支出和"不是支出"是两件事，塞 0 会让统计口径变成"所有行都有金额"）。
--    允许 NULL 是硬要求：point_ledger 已有数据，加 NOT NULL 会让旧库迁移失败。
-- 2) 汇率表：一期一条，week_start 唯一，重复插入由库挡住。

ALTER TABLE point_ledger ADD COLUMN amount_cents INTEGER;
ALTER TABLE point_ledger ADD COLUMN fx_rate REAL;

CREATE TABLE fx_rates (
  id         TEXT PRIMARY KEY,
  week_start TEXT NOT NULL UNIQUE,   -- 该汇率生效的周一（本地日 YYYY-MM-DD）
  rate       REAL NOT NULL,          -- 1 积分值多少元
  basis      TEXT NOT NULL DEFAULT '', -- AI 的评估依据，只进库不上界面
  source     TEXT NOT NULL,          -- ai | fallback
  created_at TEXT NOT NULL
);
`;
const attachmentNameSql = "-- v0.49：附件显示名。只加一列，不动 001–004。\n-- 允许空串：本迁移之前落库的老行没有名字，渲染层按 mime 兜底（49 §5.2）。\n-- 名字只用于显示，**永远不参与路径拼接**（落盘仍走 id + mime 推导）。\nALTER TABLE attachments ADD COLUMN name TEXT NOT NULL DEFAULT '';\n";
const messageModeSql = "-- v0.73：消息带上发送时的输入模式（chat / task）。\n-- 可空：本迁移之前的老行拿不到这个信息，渲染层按「轮」推断兜底（73 §G）。\nALTER TABLE messages ADD COLUMN mode TEXT;\n";
const pulseSql = "CREATE TABLE IF NOT EXISTS pulses (\n  id TEXT PRIMARY KEY,\n  title TEXT NOT NULL,\n  interval_minutes INTEGER NOT NULL,\n  window_start TEXT,\n  window_end TEXT,\n  enabled INTEGER NOT NULL DEFAULT 1,\n  last_fired_at TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n";
const alertSql = "CREATE TABLE IF NOT EXISTS alerts (\n  id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  level TEXT NOT NULL,\n  source_id TEXT NOT NULL,\n  title TEXT NOT NULL,\n  fired_at TEXT NOT NULL,\n  acked_at TEXT,\n  escalated_at TEXT\n);\n";
const MIGRATIONS = [
  { version: 1, name: "001_init", sql: initSql },
  { version: 2, name: "002_ledger_reversed", sql: ledgerReversedSql },
  { version: 3, name: "003_chat", sql: chatSql },
  { version: 4, name: "004_spend", sql: spendSql },
  { version: 5, name: "005_attachment_name", sql: attachmentNameSql },
  { version: 6, name: "006_message_mode", sql: messageModeSql },
  { version: 7, name: "007_pulse", sql: pulseSql },
  { version: 8, name: "008_alert", sql: alertSql }
];
class AppErrorException extends Error {
  code;
  detail;
  retryable;
  constructor(code, message, opts) {
    super(message, opts?.cause === void 0 ? void 0 : { cause: opts.cause });
    this.name = "AppErrorException";
    this.code = code;
    this.detail = opts?.detail;
    this.retryable = opts?.retryable ?? false;
  }
  toAppError() {
    return { code: this.code, message: this.message, detail: this.detail, retryable: this.retryable };
  }
}
function appError(code, message, opts) {
  return new AppErrorException(code, message, opts);
}
function isConstraintError(e) {
  const code = e?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true;
  const message = e instanceof Error ? e.message : "";
  return message.includes("UNIQUE constraint failed") || message.includes("FOREIGN KEY constraint failed");
}
function wrapWriteError(e, conflictMessage2) {
  if (e instanceof AppErrorException) return e;
  if (isConstraintError(e)) {
    return appError("CONFLICT", conflictMessage2, {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    });
  }
  return appError("DB_ERROR", "数据库读写失败", {
    detail: e instanceof Error ? e.message : String(e),
    retryable: true,
    cause: e
  });
}
const dayFormatters = /* @__PURE__ */ new Map();
const timeFormatters = /* @__PURE__ */ new Map();
function dayFormatter(timeZone) {
  const key = timeZone ?? "";
  let f = dayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dayFormatters.set(key, f);
  }
  return f;
}
function timeFormatter(timeZone) {
  const key = timeZone ?? "";
  let f = timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    timeFormatters.set(key, f);
  }
  return f;
}
function partOf(parts, type) {
  for (const p of parts) if (p.type === type) return p.value;
  return "";
}
function toLocalDay(d, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(d);
  return `${partOf(parts, "year")}-${partOf(parts, "month")}-${partOf(parts, "day")}`;
}
function isoToLocalDay(iso, timeZone) {
  return toLocalDay(new Date(iso), timeZone);
}
function todayLocalDay(timeZone) {
  return toLocalDay(/* @__PURE__ */ new Date(), timeZone);
}
function isoToLocalTime(iso, timeZone) {
  const parts = timeFormatter(timeZone).formatToParts(new Date(iso));
  return `${partOf(parts, "hour")}:${partOf(parts, "minute")}`;
}
const pad2$1 = (n) => n < 10 ? `0${n}` : String(n);
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function isValidDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function assertDay(day, label = "日期") {
  if (!isValidDay(day)) {
    throw appError("INVALID_INPUT", `${label} 必须是 YYYY-MM-DD 格式的本地日期`, {
      detail: `收到 ${JSON.stringify(day)}`
    });
  }
  return day;
}
function dayToUtcDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function utcDateToDay(dt) {
  return `${dt.getUTCFullYear()}-${pad2$1(dt.getUTCMonth() + 1)}-${pad2$1(dt.getUTCDate())}`;
}
function addDays(day, n) {
  const dt = dayToUtcDate(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcDateToDay(dt);
}
function addMonths(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const targetMonthIndex = m - 1 + n;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = (targetMonthIndex % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad2$1(month + 1)}-${pad2$1(Math.min(d, lastDay))}`;
}
function dayDiff(a, b) {
  return (dayToUtcDate(b).getTime() - dayToUtcDate(a).getTime()) / 864e5;
}
function isoWeekday$1(day) {
  const dow = dayToUtcDate(day).getUTCDay();
  return dow === 0 ? 7 : dow;
}
function daysBetweenInclusive(from, to) {
  const out = [];
  const total = dayDiff(from, to);
  for (let i = 0; i <= total; i += 1) out.push(addDays(from, i));
  return out;
}
function monthBounds(year, month) {
  const from = `${year}-${pad2$1(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${pad2$1(month)}-${pad2$1(lastDay)}` };
}
let current$1 = null;
const PRAGMAS = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "foreign_keys = ON",
  "busy_timeout = 5000"
];
function applyPragmas(db) {
  for (const p of PRAGMAS) db.pragma(p);
}
function getUserVersion(db) {
  return db.pragma("user_version", { simple: true });
}
function migrate(db) {
  const applied = getUserVersion(db);
  const target = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  if (applied > target) {
    throw appError("DB_ERROR", "数据库版本高于当前应用，请升级应用后再打开", {
      detail: `user_version=${applied} > 应用最高迁移 ${target}`
    });
  }
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= applied) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
      db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(`migration.${migration.name}`, nowIso());
    });
    try {
      run();
    } catch (e) {
      throw wrapWriteError(e, `迁移 ${migration.name} 执行失败`);
    }
  }
  return getUserVersion(db);
}
function openDb(file) {
  if (current$1) closeDb();
  let db;
  try {
    db = new Database(file);
  } catch (e) {
    throw wrapWriteError(e, `无法打开数据库 ${file}`);
  }
  applyPragmas(db);
  migrate(db);
  current$1 = db;
  return db;
}
function initDb(file) {
  if (file) {
    openDb(file);
    return;
  }
  if (!electron.app || typeof electron.app.getPath !== "function") {
    throw appError("DB_ERROR", "无法解析用户数据目录（非 Electron 环境请显式传入数据库路径）");
  }
  const dir = electron.app.getPath("userData");
  node_fs.mkdirSync(node_path.dirname(node_path.join(dir, "taskloop.db")), { recursive: true });
  openDb(node_path.join(dir, "taskloop.db"));
}
function getDb() {
  if (!current$1) {
    throw appError("DB_ERROR", "数据库尚未初始化", { detail: "先调用 initDb() 或 openDb()" });
  }
  return current$1;
}
function isOpen() {
  return current$1 !== null && current$1.open;
}
function closeDb() {
  if (current$1) {
    current$1.close();
    current$1 = null;
  }
}
function tx(fn) {
  const db = getDb();
  const wrapped = db.transaction(() => {
    const result = fn();
    if (result instanceof Promise) {
      throw appError("DB_ERROR", "事务回调不能是 async 函数", {
        detail: "better-sqlite3 的事务是同步的，请把 await 移到 tx() 外面"
      });
    }
    return result;
  });
  try {
    return wrapped();
  } catch (e) {
    throw wrapWriteError(e, "数据库事务失败");
  }
}
function parseJsonColumn(raw, column) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw appError("DB_ERROR", `字段 ${column} 不是合法 JSON，数据可能已损坏`, {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    });
  }
}
function parseJsonArray(raw, column) {
  const parsed = parseJsonColumn(raw, column);
  if (!Array.isArray(parsed)) {
    throw appError("DB_ERROR", `字段 ${column} 应为数组`, { detail: `实际为 ${typeof parsed}` });
  }
  return parsed;
}
const TASK_COLUMNS = [
  "id",
  "type",
  "status",
  "title",
  "detail_md",
  "parent_id",
  "sort_key",
  "priority",
  "difficulty",
  "estimate_min",
  "due_at",
  "daily_time",
  "repeat_rule",
  "active_from",
  "active_to",
  "reminder_offsets_json",
  "reminder_channels_json",
  "tags_json",
  "points_planned",
  "points_awarded",
  "quality",
  "requires_evidence",
  "evidence_json",
  "streak_current",
  "streak_best",
  "source",
  "ai_confidence",
  "ai_proposal_json",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "archived_at"
];
const TASK_INSERT_COLUMNS = [
  "id",
  "type",
  "status",
  "title",
  "detail_md",
  "parent_id",
  "sort_key",
  "priority",
  "difficulty",
  "estimate_min",
  "due_at",
  "daily_time",
  "repeat_rule",
  "active_from",
  "active_to",
  "reminder_offsets_json",
  "reminder_channels_json",
  "tags_json",
  "points_planned",
  "requires_evidence",
  "evidence_json",
  "source",
  "ai_confidence",
  "ai_proposal_json",
  "created_at",
  "updated_at",
  "started_at"
];
function taskInsertParams(t) {
  return [
    t.id,
    t.type,
    t.status,
    t.title,
    t.detailMd ?? "",
    t.parentId ?? null,
    t.sortKey ?? 0,
    t.priority ?? 0,
    t.difficulty ?? "easy",
    t.estimateMin ?? null,
    t.dueAt ?? null,
    t.dailyTime ?? null,
    t.repeatRule ?? null,
    t.activeFrom ?? null,
    t.activeTo ?? null,
    JSON.stringify(t.reminderOffsets ?? []),
    JSON.stringify(t.reminderChannels ?? ["inapp"]),
    JSON.stringify(t.tags ?? []),
    t.pointsPlanned ?? 0,
    t.requiresEvidence === true ? 1 : 0,
    JSON.stringify(t.evidence ?? []),
    t.source ?? "chat",
    t.aiConfidence ?? null,
    t.aiProposal === void 0 ? null : JSON.stringify(t.aiProposal),
    t.createdAt,
    t.updatedAt,
    t.startedAt ?? null
  ];
}
function mapTask(row2) {
  return {
    id: row2.id,
    type: row2.type,
    status: row2.status,
    title: row2.title,
    detailMd: row2.detail_md,
    parentId: row2.parent_id,
    sortKey: row2.sort_key,
    priority: row2.priority,
    difficulty: row2.difficulty,
    estimateMin: row2.estimate_min,
    dueAt: row2.due_at,
    dailyTime: row2.daily_time,
    repeatRule: row2.repeat_rule,
    activeFrom: row2.active_from,
    activeTo: row2.active_to,
    reminderOffsets: parseJsonArray(row2.reminder_offsets_json, "tasks.reminder_offsets_json"),
    reminderChannels: parseJsonArray(
      row2.reminder_channels_json,
      "tasks.reminder_channels_json"
    ),
    tags: parseJsonArray(row2.tags_json, "tasks.tags_json"),
    pointsPlanned: row2.points_planned,
    pointsAwarded: row2.points_awarded,
    quality: row2.quality ?? null,
    requiresEvidence: row2.requires_evidence === 1,
    evidence: parseJsonArray(row2.evidence_json, "tasks.evidence_json"),
    streakCurrent: row2.streak_current,
    streakBest: row2.streak_best,
    source: row2.source,
    aiConfidence: row2.ai_confidence,
    createdAt: row2.created_at,
    updatedAt: row2.updated_at,
    startedAt: row2.started_at,
    completedAt: row2.completed_at,
    archivedAt: row2.archived_at
  };
}
function taskPatchToColumns(patch2) {
  const out = {};
  if (patch2.title !== void 0) out.title = patch2.title;
  if (patch2.detailMd !== void 0) out.detail_md = patch2.detailMd;
  if (patch2.priority !== void 0) out.priority = patch2.priority;
  if (patch2.difficulty !== void 0) out.difficulty = patch2.difficulty;
  if (patch2.estimateMin !== void 0) out.estimate_min = patch2.estimateMin;
  if (patch2.dueAt !== void 0) out.due_at = patch2.dueAt;
  if (patch2.dailyTime !== void 0) out.daily_time = patch2.dailyTime;
  if (patch2.repeatRule !== void 0) out.repeat_rule = patch2.repeatRule;
  if (patch2.activeFrom !== void 0) out.active_from = patch2.activeFrom;
  if (patch2.activeTo !== void 0) out.active_to = patch2.activeTo;
  if (patch2.reminderOffsets !== void 0) out.reminder_offsets_json = JSON.stringify(patch2.reminderOffsets);
  if (patch2.reminderChannels !== void 0) {
    out.reminder_channels_json = JSON.stringify(patch2.reminderChannels);
  }
  if (patch2.requiresEvidence !== void 0) out.requires_evidence = patch2.requiresEvidence ? 1 : 0;
  if (patch2.tags !== void 0) out.tags_json = JSON.stringify(patch2.tags);
  return out;
}
const OCCURRENCE_COLUMNS = [
  "id",
  "task_id",
  "day",
  "status",
  "points_awarded",
  "completed_at",
  "note",
  "created_at",
  "updated_at"
];
const OCCURRENCE_COLUMNS_JOINED = [
  ...OCCURRENCE_COLUMNS.map((c) => `o.${c}`),
  "t.title AS task_title",
  "t.type AS task_type"
];
function mapOccurrence(row2) {
  const out = {
    id: row2.id,
    taskId: row2.task_id,
    day: row2.day,
    status: row2.status,
    pointsAwarded: row2.points_awarded,
    completedAt: row2.completed_at,
    note: row2.note
  };
  if (row2.task_title !== void 0 && row2.task_title !== null) out.taskTitle = row2.task_title;
  if (row2.task_type !== void 0 && row2.task_type !== null) out.taskType = row2.task_type;
  return out;
}
const LEDGER_COLUMNS = [
  "id",
  "task_id",
  "occurrence_id",
  "delta",
  "kind",
  "reason_code",
  "reason_text",
  "day",
  "created_at",
  "reversed_at",
  "amount_cents",
  "fx_rate"
];
function ledgerInsertParams(e) {
  return [
    e.id,
    e.taskId,
    e.occurrenceId,
    e.delta,
    e.kind,
    e.reasonCode,
    e.reasonText ?? "",
    e.day,
    e.createdAt,
    e.reversedAt ?? null,
    e.amountCents ?? null,
    e.fxRate ?? null
  ];
}
function mapPointEntry(row2) {
  return {
    id: row2.id,
    taskId: row2.task_id,
    occurrenceId: row2.occurrence_id,
    delta: row2.delta,
    kind: row2.kind,
    reasonCode: row2.reason_code,
    reasonText: row2.reason_text,
    day: row2.day,
    createdAt: row2.created_at,
    reversedAt: row2.reversed_at,
    amountCents: row2.amount_cents,
    fxRate: row2.fx_rate
  };
}
const FX_RATE_COLUMNS = [
  "id",
  "week_start",
  "rate",
  "basis",
  "source",
  "created_at"
];
function fxRateInsertParams(r) {
  return [r.id, r.weekStart, r.rate, r.basis ?? "", r.source, r.createdAt];
}
function mapFxRate(row2) {
  return {
    weekStart: row2.week_start,
    rate: row2.rate,
    source: row2.source,
    createdAt: row2.created_at
  };
}
const REMINDER_COLUMNS = [
  "id",
  "task_id",
  "occurrence_id",
  "offset_min",
  "fire_at",
  "repeat_rule",
  "channels_json",
  "level",
  "status",
  "last_fired_at",
  "fired_channels_json",
  "fail_reason",
  "created_at"
];
function reminderInsertParams(r) {
  return [
    r.id,
    r.taskId,
    r.occurrenceId,
    r.offsetMin,
    r.fireAt,
    r.repeatRule ?? null,
    JSON.stringify(r.channels),
    r.level ?? "normal",
    r.status ?? "active",
    null,
    "[]",
    null,
    r.createdAt
  ];
}
function mapReminder(row2) {
  return {
    id: row2.id,
    taskId: row2.task_id,
    occurrenceId: row2.occurrence_id,
    offsetMin: row2.offset_min,
    fireAt: row2.fire_at,
    repeatRule: row2.repeat_rule,
    channels: parseJsonArray(row2.channels_json, "reminders.channels_json"),
    level: row2.level,
    status: row2.status,
    lastFiredAt: row2.last_fired_at,
    firedChannels: parseJsonArray(
      row2.fired_channels_json,
      "reminders.fired_channels_json"
    ),
    failReason: row2.fail_reason,
    createdAt: row2.created_at
  };
}
const DAY_STAT_COLUMNS = [
  "day",
  "points",
  "tasks_done",
  "tasks_created",
  "occurrences_done"
];
function mapDayStat(row2) {
  return {
    day: row2.day,
    points: row2.points,
    tasksDone: row2.tasks_done,
    tasksCreated: row2.tasks_created,
    occurrencesDone: row2.occurrences_done
  };
}
function emptyDayStat(day) {
  return { day, points: 0, tasksDone: 0, tasksCreated: 0, occurrencesDone: 0 };
}
const MESSAGE_COLUMNS = [
  "id",
  "thread_id",
  "role",
  "kind",
  "content_md",
  "meta_json",
  "linked_task_id",
  "status",
  "mode",
  "tokens_in",
  "tokens_out",
  "latency_ms",
  "created_at"
];
const ATTACHMENT_COLUMNS = [
  "id",
  "message_id",
  "task_id",
  "kind",
  "rel_path",
  "mime",
  "bytes",
  "width",
  "height",
  "sha256",
  "created_at",
  "name"
];
function mapAttachment(row2) {
  return {
    id: row2.id,
    kind: row2.kind,
    name: row2.name,
    url: `app://attach/${row2.id}`,
    mime: row2.mime,
    bytes: row2.bytes,
    width: row2.width,
    height: row2.height
  };
}
function mapMessageMeta(kind, raw) {
  const parsed = parseJsonColumn(raw, "messages.meta_json");
  switch (kind) {
    case "task_draft": {
      const drafts = parsed.drafts;
      return { kind: "task_draft", drafts: Array.isArray(drafts) ? drafts : [] };
    }
    case "task_review": {
      const verdict = parsed.verdict;
      if (!verdict || typeof verdict !== "object") {
        throw appError("DB_ERROR", "字段 messages.meta_json 的 task_review 缺少 verdict", {
          detail: `实际为 ${verdict === null ? "null" : typeof verdict}`
        });
      }
      return {
        kind: "task_review",
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : "",
        verdict
      };
    }
    case "reminder":
      return {
        kind: "reminder",
        reminderId: typeof parsed.reminderId === "string" ? parsed.reminderId : "",
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : null,
        title: typeof parsed.title === "string" ? parsed.title : "",
        fireAt: typeof parsed.fireAt === "string" ? parsed.fireAt : "",
        // 写入方从 reminders.offset_min 抄进 meta_json；缺失即视为绝对时间（如每日任务按 dailyTime 触发），
        // 不拿 fireAt - dueAt 现算——那会因为 due_at 改过而算错。
        offsetMin: typeof parsed.offsetMin === "number" ? parsed.offsetMin : null
      };
    case "error":
      return {
        kind: "error",
        code: parsed.code ?? "UNKNOWN",
        message: typeof parsed.message === "string" ? parsed.message : "",
        retryable: parsed.retryable === true
      };
    default:
      return { kind: "none" };
  }
}
function mapMessage(row2, attachments) {
  return {
    id: row2.id,
    threadId: row2.thread_id,
    role: row2.role,
    kind: row2.kind,
    contentMd: row2.content_md,
    meta: mapMessageMeta(row2.kind, row2.meta_json),
    linkedTaskId: row2.linked_task_id,
    status: row2.status,
    // 库里若有脏值就当 null（走轮推断兜底），不用 `as ChatMode` 硬转
    mode: row2.mode === "chat" || row2.mode === "task" ? row2.mode : null,
    attachments,
    createdAt: row2.created_at
  };
}
function messageInsertParams(m) {
  return [
    m.id,
    m.threadId ?? "main",
    m.role,
    m.kind,
    m.contentMd ?? "",
    JSON.stringify(m.meta ?? { kind: "none" }),
    m.linkedTaskId ?? null,
    m.status ?? "sent",
    m.mode ?? null,
    m.tokensIn ?? null,
    m.tokensOut ?? null,
    m.latencyMs ?? null,
    m.createdAt
  ];
}
const PULSE_COLUMNS = [
  "id",
  "title",
  "interval_minutes",
  "window_start",
  "window_end",
  "enabled",
  "last_fired_at",
  "created_at",
  "updated_at"
];
function mapPulse(row2) {
  return {
    id: row2.id,
    title: row2.title,
    intervalMinutes: row2.interval_minutes,
    windowStart: row2.window_start,
    windowEnd: row2.window_end,
    enabled: row2.enabled === 1,
    lastFiredAt: row2.last_fired_at,
    createdAt: row2.created_at,
    updatedAt: row2.updated_at
  };
}
const ALERT_COLUMNS = [
  "id",
  "kind",
  "level",
  "source_id",
  "title",
  "fired_at",
  "acked_at",
  "escalated_at"
];
function mapAlert(row2) {
  return {
    id: row2.id,
    kind: row2.kind,
    level: row2.level,
    sourceId: row2.source_id,
    title: row2.title,
    firedAt: row2.fired_at,
    ackedAt: row2.acked_at,
    escalatedAt: row2.escalated_at
  };
}
function placeholders(count2) {
  return new Array(count2).fill("?").join(", ");
}
function buildSetClause(columns) {
  const keys = Object.keys(columns);
  if (keys.length === 0) return { clause: "", values: [] };
  return {
    clause: keys.map((k) => `${k} = ?`).join(", "),
    values: keys.map((k) => columns[k])
  };
}
const SELECT_ATTACHMENT = `SELECT ${ATTACHMENT_COLUMNS.join(", ")} FROM attachments`;
function insertParams(a) {
  return [
    a.id,
    a.messageId,
    a.taskId ?? null,
    a.kind,
    a.relPath,
    a.mime,
    a.bytes,
    a.width ?? null,
    a.height ?? null,
    a.sha256,
    a.createdAt,
    a.name ?? ""
  ];
}
function insert$8(a) {
  try {
    getDb().prepare(
      `INSERT INTO attachments (${ATTACHMENT_COLUMNS.join(", ")})
         VALUES (${placeholders(ATTACHMENT_COLUMNS.length)})`
    ).run(...insertParams(a));
  } catch (e) {
    throw wrapWriteError(e, "附件记录写入失败");
  }
  const row2 = attachmentRowById(a.id);
  if (!row2) throw wrapWriteError(new Error("插入后读不回"), "附件记录写入失败");
  return mapAttachment(row2);
}
function attachmentRowById(id) {
  const row2 = getDb().prepare(`${SELECT_ATTACHMENT} WHERE id = ?`).get(id);
  return row2 ?? null;
}
function attachmentById(id) {
  const row2 = attachmentRowById(id);
  return row2 ? mapAttachment(row2) : null;
}
function findBySha(sha256, mime) {
  const row2 = getDb().prepare(`${SELECT_ATTACHMENT} WHERE sha256 = ? AND mime = ? LIMIT 1`).get(sha256, mime);
  return row2 ?? null;
}
function listAttachments$1(messageId) {
  return getDb().prepare(`${SELECT_ATTACHMENT} WHERE message_id = ? ORDER BY rowid`).all(messageId).map(mapAttachment);
}
function attachmentsFor(messageIds) {
  const out = /* @__PURE__ */ new Map();
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500);
    const rows = getDb().prepare(
      `SELECT ${ATTACHMENT_COLUMNS.join(", ")} FROM attachments
         WHERE message_id IN (${placeholders(chunk.length)})
         ORDER BY rowid`
    ).all(...chunk);
    for (const row2 of rows) {
      const key = row2.message_id ?? "";
      const list2 = out.get(key) ?? [];
      list2.push(mapAttachment(row2));
      out.set(key, list2);
    }
  }
  return out;
}
function attachToMessage(messageId, attachmentIds) {
  if (attachmentIds.length === 0) return;
  tx(() => {
    const stmt = getDb().prepare("UPDATE attachments SET message_id = ? WHERE id = ?");
    for (const id of attachmentIds) stmt.run(messageId, id);
  });
}
function remove$4(id) {
  getDb().prepare("DELETE FROM attachments WHERE id = ?").run(id);
}
const attachmentRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  attachToMessage,
  attachmentById,
  attachmentRowById,
  attachmentsFor,
  findBySha,
  insert: insert$8,
  listAttachments: listAttachments$1,
  remove: remove$4
}, Symbol.toStringTag, { value: "Module" }));
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf"
};
const ALLOWED_MIMES = Object.keys(ATTACHMENT_MIME_EXT);
function normalizeMime(raw) {
  const cut = raw.indexOf(";");
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim().toLowerCase();
}
function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIME_EXT, mime);
}
function extForMime(mime) {
  if (!isAllowedMime(mime)) {
    throw appError("UNSUPPORTED_MIME", `不支持的附件类型：${mime || "（空）"}`, {
      detail: `白名单：${ALLOWED_MIMES.join(", ")}`
    });
  }
  return ATTACHMENT_MIME_EXT[mime];
}
function kindForMime(mime) {
  return isAllowedMime(mime) && mime.startsWith("image/") ? "image" : "file";
}
const DISPLAY_NAME_MAX = 60;
function displayName(raw, mime) {
  const cleaned = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return `${kindForMime(mime)}.${extForMime(mime)}`;
  return cleaned.length > DISPLAY_NAME_MAX ? cleaned.slice(0, DISPLAY_NAME_MAX) : cleaned;
}
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{12}$/;
function isAttachmentId(value) {
  return typeof value === "string" && ATTACHMENT_ID_RE.test(value);
}
let root = null;
function defaultRoot() {
  if (!electron.app || typeof electron.app.getPath !== "function") {
    throw appError("DB_ERROR", "无法解析附件目录（非 Electron 环境请先 initAttachmentRoot）", {
      detail: "app.getPath 不可用"
    });
  }
  return node_path.join(electron.app.getPath("userData"), "attachments");
}
function initAttachmentRoot(dir) {
  root = dir ?? defaultRoot();
  return root;
}
function attachmentRoot() {
  return root ?? initAttachmentRoot();
}
function resetAttachmentRoot() {
  root = null;
}
function attachmentRelPath(id, mime, day = todayLocalDay()) {
  const ext = extForMime(mime);
  return `${day.slice(0, 4)}/${day.slice(5, 7)}/${id}.${ext}`;
}
function resolveWithinRoot(rootDir, relPath) {
  if (relPath.length === 0 || relPath.includes("\0")) return null;
  const base = node_path.resolve(rootDir);
  const abs = node_path.resolve(base, relPath);
  if (abs === base) return null;
  return abs.startsWith(base + node_path.sep) ? abs : null;
}
const NOT_FOUND_BODY = new TextEncoder().encode("attachment not found");
function notFound() {
  return {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: NOT_FOUND_BODY
  };
}
function serverError(detail) {
  return {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: new TextEncoder().encode(`attachment unavailable: ${detail}`)
  };
}
function isMissingFile(e) {
  const code = e?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
function attachmentIdFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "app:" || url.hostname !== "attach") return null;
  const id = url.pathname.startsWith("/") ? url.pathname.slice(1) : "";
  return isAttachmentId(id) ? id : null;
}
function handleAttachmentRequest(rawUrl, deps) {
  const id = attachmentIdFromUrl(rawUrl);
  if (!id) return notFound();
  let row2;
  try {
    row2 = deps.lookup(id);
  } catch (e) {
    return serverError(e instanceof Error ? e.message : String(e));
  }
  if (!row2) return notFound();
  let absPath;
  try {
    absPath = resolveWithinRoot(deps.root(), row2.relPath);
  } catch (e) {
    return serverError(e instanceof Error ? e.message : String(e));
  }
  if (!absPath) return notFound();
  let bytes;
  try {
    bytes = deps.readFile(absPath);
  } catch (e) {
    return isMissingFile(e) ? notFound() : serverError(e instanceof Error ? e.message : String(e));
  }
  const headers = {
    "content-type": row2.mime,
    "content-length": String(bytes.byteLength)
  };
  if (row2.mime === "application/pdf") headers["content-disposition"] = "inline";
  return {
    status: 200,
    headers,
    body: bytes
  };
}
let schemeRegistered = false;
let protocolHandled = false;
function registerAttachmentScheme() {
  if (schemeRegistered) return;
  schemeRegistered = true;
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        // 有 host，`app://attach/<id>` 才能按 URL 语义解析
        secure: true,
        // 算安全源，否则混合内容会被拦
        supportFetchAPI: true,
        // 渲染层要 fetch 也走得通（当前只用 <img src>）
        stream: true
        // 大 PDF 不整块读进内存也行
      }
    }
  ]);
}
function registerAttachmentProtocol() {
  if (protocolHandled) return;
  protocolHandled = true;
  electron.protocol.handle(
    "app",
    (request) => Promise.resolve(
      handleAttachmentRequest(request.url, {
        root: attachmentRoot,
        lookup: (id) => {
          const row2 = attachmentRowById(id);
          return row2 ? { relPath: row2.rel_path, mime: row2.mime } : null;
        },
        readFile: (absPath) => node_fs.readFileSync(absPath)
      })
    ).then((res) => new Response(res.body, { status: res.status, headers: res.headers }))
  );
}
const AUTOSTART_FLAG = "--autostart";
const SEEDED_FILE = "autostart.seeded";
function isAutoStart(argv) {
  return argv.some((arg) => arg === AUTOSTART_FLAG);
}
function loginItemArgs(opts) {
  if (opts.isPackaged) {
    return { path: opts.execPath, args: [AUTOSTART_FLAG] };
  }
  const appArg = opts.appPath.includes(" ") ? `"${opts.appPath}"` : opts.appPath;
  return { path: opts.execPath, args: [appArg, AUTOSTART_FLAG] };
}
function hasApp$1() {
  return typeof electron.app === "object" && electron.app !== null && typeof electron.app.getPath === "function";
}
function warn(step, e) {
  const name2 = e instanceof Error ? e.name : String(e);
  console.warn(`[autostart] ${step} 失败`, name2);
}
function seedAutoStart() {
  if (!hasApp$1()) return;
  let flagPath;
  try {
    flagPath = node_path.join(electron.app.getPath("userData"), SEEDED_FILE);
    if (node_fs.existsSync(flagPath)) return;
  } catch (e) {
    warn("取标记文件路径", e);
    return;
  }
  try {
    if (electron.app.getLoginItemSettings().openAtLogin !== true) {
      electron.app.setLoginItemSettings({
        openAtLogin: true,
        ...loginItemArgs({
          isPackaged: electron.app.isPackaged,
          execPath: process.execPath,
          appPath: electron.app.getAppPath()
        })
      });
    }
  } catch (e) {
    warn("写开机启动项", e);
  }
  try {
    node_fs.writeFileSync(flagPath, (/* @__PURE__ */ new Date()).toISOString(), "utf8");
  } catch (e) {
    warn("写标记文件", e);
  }
}
const EDGES = {
  // v0.25：todo 可直达 reviewing。界面没有「开始」按钮，新建任务默认就是 todo，
  // 不允许这条边等于「新建的限时/活动任务永远完不成」。01 §3 的调度器同样需要这条边。
  // v0.38：点完成的落点改成 pending_review（待提交），reviewing 那条边保留给历史数据与调度器。
  todo: ["doing", "pending_review", "reviewing", "discarded", "archived"],
  doing: ["todo", "pending_review", "reviewing", "discarded", "archived"],
  // 待提交的四个出口：提交审核 / 取消或超时回 doing / 丢弃 / 归档
  pending_review: ["reviewing", "doing", "discarded", "archived"],
  reviewing: ["doing", "done", "missed", "discarded", "archived"],
  done: ["doing", "archived"],
  // v0.34：missed 是终点状态，只有归档一条出口（驳回后超期判失败，不给"复活"）
  missed: ["archived"],
  discarded: ["archived"],
  archived: []
};
const LABEL = {
  todo: "待办",
  doing: "进行中",
  pending_review: "待提交",
  reviewing: "待确认",
  done: "已完成",
  missed: "未完成",
  discarded: "已丢弃",
  archived: "已归档"
};
function isDailyForbidden(to) {
  return to === "pending_review" || to === "reviewing" || to === "done";
}
function isTransitionAllowed(type, from, to) {
  if (type === "daily" && isDailyForbidden(to)) return false;
  if (from === to) return true;
  return EDGES[from].includes(to);
}
function assertTransition(type, from, to) {
  if (isTransitionAllowed(type, from, to)) return;
  if (type === "daily" && isDailyForbidden(to)) {
    throw appError("CONFLICT", "每日任务不进入审核/完成状态，请完成当天的打卡", {
      detail: `type=daily, ${from} → ${to}`
    });
  }
  throw appError("CONFLICT", `任务不能从「${LABEL[from]}」直接变为「${LABEL[to]}」`, {
    detail: `${from} → ${to}`
  });
}
const DEFAULT_SETTINGS = {
  "ai.provider": { name: "zhipu", model: "glm-5.3-flash" },
  // v0.37（第 18 个 key）：闲聊与记忆提取用的便宜模型。纯文本、200K、强制思考。
  "ai.chat.model": "glm-4.7-flashx",
  // v0.59b（第 20 个 key）：基址，不含 /chat/completions（路径由 glmClient.endpointOf 拼）
  "ai.baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "hud.mode": "ball",
  "hud.displayId": null,
  "hud.position": { x: null, y: null },
  "hud.size": null,
  "hud.background": null,
  "hud.opacity": 1,
  "hud.autoHideFullscreen": true,
  "points.difficultyBase": { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  // v0.54（第 19 个 key）：仅限时的难度基数，活动与每日仍走上面那张共用表
  "points.deadlineBase": { easy: 2, medium: 3, hard: 5 },
  "points.dailyBase": 1,
  "points.streakBonus": [
    { days: 7, bonus: 5 },
    { days: 30, bonus: 10 }
  ],
  "points.dailyCap": null,
  "reminder.quietHours": { from: "22:00", to: "08:00" },
  "reminder.channels": ["inapp", "toast"],
  "channel.mail": { to: "" },
  "channel.webhook": null,
  "app.theme": "light"
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
function isSettingKey(key) {
  return SETTING_KEYS.includes(key);
}
function cloneDefaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
function newId(size = 12) {
  const bytes = node_crypto.randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += ALPHABET[bytes[i] & 63];
  }
  return out;
}
const SELECT_TASK = `SELECT ${TASK_COLUMNS.join(", ")} FROM tasks`;
function insert$7(input) {
  const columns = TASK_INSERT_COLUMNS.join(", ");
  const sql = `INSERT INTO tasks (${columns}) VALUES (${placeholders(TASK_INSERT_COLUMNS.length)})`;
  try {
    getDb().prepare(sql).run(...taskInsertParams(input));
  } catch (e) {
    throw wrapWriteError(e, "任务写入失败（id 重复或父任务不存在）");
  }
  return requireById$6(input.id);
}
function getById$5(id) {
  const row2 = getDb().prepare(`${SELECT_TASK} WHERE id = ?`).get(id);
  return row2 ? mapTask(row2) : null;
}
function requireById$6(id) {
  const task = getById$5(id);
  if (!task) throw appError("NOT_FOUND", "任务不存在", { detail: `id=${id}` });
  return task;
}
function list$5(options = {}) {
  const statuses = options.status ?? ["todo", "doing", "pending_review", "reviewing"];
  if (statuses.length === 0) return [];
  const where = [`status IN (${placeholders(statuses.length)})`];
  const params = [...statuses];
  if (options.types && options.types.length > 0) {
    where.push(`type IN (${placeholders(options.types.length)})`);
    params.push(...options.types);
  }
  if (options.parentId !== void 0) {
    if (options.parentId === null) {
      where.push("parent_id IS NULL");
    } else {
      where.push("parent_id = ?");
      params.push(options.parentId);
    }
  } else if (options.includeSubtasks !== true) {
    where.push("parent_id IS NULL");
  }
  let sql = `${SELECT_TASK} WHERE ${where.join(" AND ")} ORDER BY sort_key ASC, created_at ASC`;
  if (options.limit !== void 0) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  return getDb().prepare(sql).all(...params).map(mapTask);
}
function listSubtasks(parentId) {
  return getDb().prepare(`${SELECT_TASK} WHERE parent_id = ? ORDER BY sort_key ASC, created_at ASC`).all(parentId).map(mapTask);
}
function listDailyActive() {
  return getDb().prepare(`${SELECT_TASK} WHERE type = 'daily' AND status IN ('todo','doing') AND parent_id IS NULL ORDER BY sort_key ASC`).all().map(mapTask);
}
function updateColumns(id, columns, updatedAt) {
  const cols = { ...columns, updated_at: updatedAt };
  const { clause, values } = buildSetClause(cols);
  const changes = getDb().prepare(`UPDATE tasks SET ${clause} WHERE id = ?`).run(...values, id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "任务不存在", { detail: `id=${id}` });
  return requireById$6(id);
}
function update$5(id, patch2, updatedAt) {
  const cols = taskPatchToColumns(patch2);
  if (Object.keys(cols).length === 0) return requireById$6(id);
  return updateColumns(id, cols, updatedAt);
}
function setRequiresEvidence$1(id, value, updatedAt) {
  return updateColumns(id, { requires_evidence: value ? 1 : 0 }, updatedAt);
}
function appendEvidence(id, evidence, updatedAt) {
  const task = requireById$6(id);
  const next = [...task.evidence, evidence];
  return updateColumns(id, { evidence_json: JSON.stringify(next) }, updatedAt);
}
function replaceEvidence(id, evidence, updatedAt) {
  if (evidence.length === 0) throw appError("INVALID_INPUT", "证据不能为空");
  return updateColumns(id, { evidence_json: JSON.stringify(evidence) }, updatedAt);
}
function removeEvidenceAt(id, index, updatedAt) {
  const task = requireById$6(id);
  if (index >= task.evidence.length) throw appError("INVALID_INPUT", "证据下标越界");
  const next = task.evidence.filter((_, i) => i !== index);
  return updateColumns(id, { evidence_json: JSON.stringify(next) }, updatedAt);
}
function softRemove(id, updatedAt) {
  const changes = getDb().prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run("discarded", updatedAt, id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "任务不存在", { detail: `id=${id}` });
}
function hardDelete(id) {
  const changes = getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "任务不存在", { detail: `id=${id}` });
}
function siblings(parentId, excludeId) {
  const sql = parentId === null ? `${SELECT_TASK} WHERE parent_id IS NULL AND id != ? ORDER BY sort_key ASC` : `${SELECT_TASK} WHERE parent_id = ? AND id != ? ORDER BY sort_key ASC`;
  const params = parentId === null ? [excludeId] : [parentId, excludeId];
  return getDb().prepare(sql).all(...params).map(mapTask);
}
function reorder(id, beforeId, updatedAt) {
  const task = requireById$6(id);
  if (beforeId === id) return;
  tx(() => {
    const list_ = siblings(task.parentId, id);
    let newKey;
    if (beforeId === null) {
      const last = list_[list_.length - 1];
      newKey = last ? last.sortKey + 1024 : 1024;
    } else {
      const index = list_.findIndex((t) => t.id === beforeId);
      if (index === -1) throw appError("NOT_FOUND", "参照任务不存在或不在同一层级", { detail: beforeId });
      const before = list_[index];
      const prev = index > 0 ? list_[index - 1] : null;
      if (prev) {
        const gap = before.sortKey - prev.sortKey;
        if (gap < 1e-3) {
          list_.forEach((t, i) => {
            getDb().prepare("UPDATE tasks SET sort_key = ? WHERE id = ?").run((i + 2) * 1024, t.id);
          });
          const beforeKey = (index + 2) * 1024;
          newKey = beforeKey - 512;
        } else {
          newKey = (prev.sortKey + before.sortKey) / 2;
        }
      } else {
        newKey = before.sortKey - 1024;
      }
    }
    getDb().prepare("UPDATE tasks SET sort_key = ?, updated_at = ? WHERE id = ?").run(newKey, updatedAt, id);
  });
}
function nextSortKey(parentId) {
  const row2 = parentId === null ? getDb().prepare("SELECT MAX(sort_key) AS k FROM tasks WHERE parent_id IS NULL").get() : getDb().prepare("SELECT MAX(sort_key) AS k FROM tasks WHERE parent_id = ?").get(parentId);
  return (row2.k ?? 0) + 1024;
}
function countAll$4() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get();
  return row2.n;
}
const taskRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  appendEvidence,
  countAll: countAll$4,
  getById: getById$5,
  hardDelete,
  insert: insert$7,
  list: list$5,
  listDailyActive,
  listSubtasks,
  nextSortKey,
  removeEvidenceAt,
  reorder,
  replaceEvidence,
  requireById: requireById$6,
  setRequiresEvidence: setRequiresEvidence$1,
  softRemove,
  update: update$5,
  updateColumns
}, Symbol.toStringTag, { value: "Module" }));
const SELECT_OCCURRENCE = `SELECT ${OCCURRENCE_COLUMNS.join(", ")} FROM task_occurrences`;
const SELECT_OCCURRENCE_JOINED = `SELECT ${OCCURRENCE_COLUMNS_JOINED.join(", ")}
  FROM task_occurrences o JOIN tasks t ON t.id = o.task_id`;
function insertIfAbsent(taskId, day, createdAt) {
  try {
    return getDb().prepare(
      `INSERT OR IGNORE INTO task_occurrences
             (id, task_id, day, status, points_awarded, completed_at, note, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`
    ).run(newId(), taskId, day, createdAt, createdAt).changes > 0;
  } catch (e) {
    throw wrapWriteError(e, "每日任务的当天记录写入失败");
  }
}
function getById$4(id) {
  const row2 = getDb().prepare(`${SELECT_OCCURRENCE} WHERE id = ?`).get(id);
  return row2 ? mapOccurrence(row2) : null;
}
function requireById$5(id) {
  const occ = getById$4(id);
  if (!occ) throw appError("NOT_FOUND", "打卡记录不存在", { detail: `id=${id}` });
  return occ;
}
function listByDay(day) {
  return getDb().prepare(
    `${SELECT_OCCURRENCE_JOINED} WHERE o.day = ?
         AND t.status NOT IN ('discarded', 'archived')
       ORDER BY t.sort_key ASC, o.id ASC`
  ).all(day).map(mapOccurrence);
}
function removeUnfinishedFrom(taskId, fromDay) {
  return getDb().prepare(
    `DELETE FROM task_occurrences
       WHERE task_id = ? AND day >= ? AND status <> 'done'`
  ).run(taskId, fromDay).changes;
}
function listByRange(from, to) {
  return getDb().prepare(
    `${SELECT_OCCURRENCE_JOINED} WHERE o.day >= ? AND o.day <= ?
       ORDER BY o.day ASC, t.sort_key ASC, o.id ASC`
  ).all(from, to).map(mapOccurrence);
}
function listByTask$2(taskId) {
  return getDb().prepare(`${SELECT_OCCURRENCE} WHERE task_id = ? ORDER BY day ASC`).all(taskId).map(mapOccurrence);
}
function update$4(id, patch2, updatedAt) {
  const cols = { updated_at: updatedAt };
  if (patch2.status !== void 0) cols.status = patch2.status;
  if (patch2.pointsAwarded !== void 0) cols.points_awarded = patch2.pointsAwarded;
  if (patch2.completedAt !== void 0) cols.completed_at = patch2.completedAt;
  if (patch2.note !== void 0) cols.note = patch2.note;
  const { clause, values } = buildSetClause(cols);
  const changes = getDb().prepare(`UPDATE task_occurrences SET ${clause} WHERE id = ?`).run(...values, id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "打卡记录不存在", { detail: `id=${id}` });
  return requireById$5(id);
}
function countAll$3() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM task_occurrences").get();
  return row2.n;
}
function countByTask(taskId) {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM task_occurrences WHERE task_id = ?").get(taskId);
  return row2.n;
}
function markMissedBefore$1(day, updatedAt) {
  return getDb().prepare(
    `UPDATE task_occurrences SET status = 'missed', updated_at = ?
       WHERE day < ? AND status = 'pending'`
  ).run(updatedAt, day).changes;
}
const occurrenceRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  countAll: countAll$3,
  countByTask,
  getById: getById$4,
  insertIfAbsent,
  listByDay,
  listByRange,
  listByTask: listByTask$2,
  markMissedBefore: markMissedBefore$1,
  removeUnfinishedFrom,
  requireById: requireById$5,
  update: update$4
}, Symbol.toStringTag, { value: "Module" }));
const SELECT_MESSAGE = `SELECT ${MESSAGE_COLUMNS.join(", ")} FROM messages`;
function insert$6(input) {
  try {
    getDb().prepare(
      `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
         VALUES (${placeholders(MESSAGE_COLUMNS.length)})`
    ).run(...messageInsertParams(input));
  } catch (e) {
    throw wrapWriteError(e, "消息写入失败");
  }
  return requireById$4(input.id);
}
function getById$3(id) {
  const row2 = getDb().prepare(`${SELECT_MESSAGE} WHERE id = ?`).get(id);
  if (!row2) return null;
  return mapMessage(row2, attachmentsFor([id]).get(id) ?? []);
}
function requireById$4(id) {
  const message = getById$3(id);
  if (!message) throw appError("NOT_FOUND", "消息不存在", { detail: `id=${id}` });
  return message;
}
function patch(id, input) {
  const cols = {};
  if (input.contentMd !== void 0) cols.content_md = input.contentMd;
  if (input.status !== void 0) cols.status = input.status;
  if (input.meta !== void 0) cols.meta_json = JSON.stringify(input.meta);
  if (input.linkedTaskId !== void 0) cols.linked_task_id = input.linkedTaskId;
  if (input.tokensIn !== void 0) cols.tokens_in = input.tokensIn;
  if (input.tokensOut !== void 0) cols.tokens_out = input.tokensOut;
  if (input.latencyMs !== void 0) cols.latency_ms = input.latencyMs;
  if (Object.keys(cols).length === 0) return requireById$4(id);
  const { clause, values } = buildSetClause(cols);
  const changes = getDb().prepare(`UPDATE messages SET ${clause} WHERE id = ?`).run(...values, id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "消息不存在", { detail: `id=${id}` });
  return requireById$4(id);
}
function listRecent$1(limit = 30) {
  const rows = getDb().prepare(`${SELECT_MESSAGE} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit);
  return hydrate(rows.reverse());
}
function listBefore(before, limit = 30) {
  const anchor2 = getDb().prepare("SELECT created_at, rowid AS rid FROM messages WHERE id = ?").get(before);
  if (!anchor2) throw appError("NOT_FOUND", "分页游标消息不存在", { detail: `id=${before}` });
  const rows = getDb().prepare(
    `${SELECT_MESSAGE} WHERE (created_at < ?) OR (created_at = ? AND rowid < ?)
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(anchor2.created_at, anchor2.created_at, anchor2.rid, limit);
  return hydrate(rows.reverse());
}
function listByThread(threadId, limit = 30) {
  const rows = getDb().prepare(`${SELECT_MESSAGE} WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(threadId, limit);
  return hydrate(rows.reverse());
}
function listRecentText(limit = 20, excludeId) {
  const rows = excludeId === void 0 ? getDb().prepare(
    `${SELECT_MESSAGE} WHERE kind = 'text' ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(limit) : getDb().prepare(
    `${SELECT_MESSAGE} WHERE kind = 'text' AND id <> ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(excludeId, limit);
  return hydrate(rows.reverse());
}
function countAll$2() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM messages").get();
  return row2.n;
}
function removeById(id) {
  return getDb().prepare("DELETE FROM messages WHERE id = ?").run(id).changes > 0;
}
function removeMany(ids) {
  if (ids.length === 0) return 0;
  const stmt = getDb().prepare("DELETE FROM messages WHERE id = ?");
  return tx(() => {
    let changes = 0;
    for (const id of ids) changes += stmt.run(id).changes;
    return changes;
  });
}
function listTextAfter(afterId, limit = 200) {
  if (afterId === null) {
    const rows2 = getDb().prepare(`${SELECT_MESSAGE} WHERE kind = 'text' ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(limit);
    return hydrate(rows2);
  }
  const anchor2 = getDb().prepare("SELECT rowid AS rid FROM messages WHERE id = ?").get(afterId);
  if (!anchor2) return [];
  const rows = getDb().prepare(`${SELECT_MESSAGE} WHERE kind = 'text' AND rowid > ? ORDER BY rowid ASC LIMIT ?`).all(anchor2.rid, limit);
  return hydrate(rows);
}
function hydrate(rows) {
  if (rows.length === 0) return [];
  const byMessage = attachmentsFor(rows.map((r) => r.id));
  return rows.map((row2) => mapMessage(row2, byMessage.get(row2.id) ?? []));
}
function isMessageKind(value) {
  return ["text", "task_draft", "task_review", "reminder", "error"].includes(value);
}
const messageRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  attachToMessage,
  countAll: countAll$2,
  getById: getById$3,
  insert: insert$6,
  insertAttachment: insert$8,
  isMessageKind,
  listAttachments: listAttachments$1,
  listBefore,
  listByThread,
  listRecent: listRecent$1,
  listRecentText,
  listTextAfter,
  patch,
  removeAttachment: remove$4,
  removeById,
  removeMany,
  requireById: requireById$4
}, Symbol.toStringTag, { value: "Module" }));
const SELECT_LEDGER = `SELECT ${LEDGER_COLUMNS.join(", ")} FROM point_ledger`;
function conflictMessage(e) {
  if (!isConstraintError(e)) return null;
  const raw = e instanceof Error ? e.message : "";
  if (raw.includes("point_ledger.occurrence_id")) return "这一天的打卡已经发过分了";
  if (raw.includes("point_ledger.task_id")) return "这个任务已经发过完成分了";
  return "流水重复，已被唯一索引拒绝";
}
function insert$5(entry) {
  try {
    getDb().prepare(
      `INSERT INTO point_ledger (${LEDGER_COLUMNS.join(", ")})
         VALUES (${placeholders(LEDGER_COLUMNS.length)})`
    ).run(...ledgerInsertParams(entry));
  } catch (e) {
    const message = conflictMessage(e);
    if (message) {
      throw appError("CONFLICT", message, {
        detail: e instanceof Error ? e.message : String(e),
        cause: e
      });
    }
    throw wrapWriteError(e, "积分流水写入失败");
  }
  const row2 = getDb().prepare(`${SELECT_LEDGER} WHERE id = ?`).get(entry.id);
  return mapPointEntry(row2);
}
function balance$1() {
  const row2 = getDb().prepare("SELECT COALESCE(SUM(delta), 0) AS total FROM point_ledger").get();
  return row2.total;
}
function sumByDay(day) {
  const row2 = getDb().prepare("SELECT COALESCE(SUM(delta), 0) AS total FROM point_ledger WHERE day = ?").get(day);
  return row2.total;
}
function list$4(options = {}) {
  const where = [];
  const params = [];
  if (options.from) {
    where.push("day >= ?");
    params.push(options.from);
  }
  if (options.to) {
    where.push("day <= ?");
    params.push(options.to);
  }
  let sql = SELECT_LEDGER;
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at DESC, id DESC";
  if (options.limit !== void 0) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  return getDb().prepare(sql).all(...params).map(mapPointEntry);
}
function recent(limit = 20) {
  return list$4({ limit });
}
function listByTask$1(taskId) {
  return getDb().prepare(`${SELECT_LEDGER} WHERE task_id = ? ORDER BY created_at ASC, id ASC`).all(taskId).map(mapPointEntry);
}
function byId(id) {
  const row2 = getDb().prepare(`${SELECT_LEDGER} WHERE id = ?`).get(id);
  return row2 === void 0 ? null : mapPointEntry(row2);
}
function sumSpendCents(from, to) {
  const row2 = getDb().prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM point_ledger
       WHERE kind = 'spend' AND reversed_at IS NULL AND day >= ? AND day <= ?`
  ).get(from, to);
  return row2.total;
}
function listSpend(from, to) {
  return getDb().prepare(
    `${SELECT_LEDGER}
       WHERE kind = 'spend' AND reversed_at IS NULL AND day >= ? AND day <= ?
       ORDER BY created_at DESC, id DESC`
  ).all(from, to).map(mapPointEntry);
}
function hasTaskDoneEntry(taskId) {
  const row2 = getDb().prepare(
    `SELECT 1 AS hit FROM point_ledger
       WHERE task_id = ? AND reason_code = 'task_done' AND occurrence_id IS NULL
         AND reversed_at IS NULL
       LIMIT 1`
  ).get(taskId);
  return row2 !== void 0;
}
function markReversed(id, at) {
  const info = getDb().prepare("UPDATE point_ledger SET reversed_at = ? WHERE id = ? AND reversed_at IS NULL").run(at, id);
  if (info.changes === 0) {
    throw appError("DB_ERROR", "流水冲销状态异常", {
      detail: `point_ledger ${id} 不存在或已经被冲销过`,
      retryable: false
    });
  }
}
function countAll$1() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM point_ledger").get();
  return row2.n;
}
const ledgerRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  balance: balance$1,
  byId,
  countAll: countAll$1,
  hasTaskDoneEntry,
  insert: insert$5,
  list: list$4,
  listByTask: listByTask$1,
  listSpend,
  markReversed,
  recent,
  sumByDay,
  sumSpendCents
}, Symbol.toStringTag, { value: "Module" }));
const SELECT_REMINDER = `SELECT ${REMINDER_COLUMNS.join(", ")} FROM reminders`;
function listByTask(taskId) {
  return getDb().prepare(`${SELECT_REMINDER} WHERE task_id = ? ORDER BY fire_at ASC`).all(taskId).map(mapReminder);
}
function listUpcoming(limit = 20) {
  return getDb().prepare(
    `${SELECT_REMINDER} WHERE status = 'active' ORDER BY fire_at ASC LIMIT ?`
  ).all(limit).map(mapReminder);
}
function listDue(nowIsoText, limit = 50) {
  return getDb().prepare(
    `${SELECT_REMINDER} WHERE status = 'active' AND fire_at <= ?
       ORDER BY fire_at ASC LIMIT ?`
  ).all(nowIsoText, limit).map(mapReminder);
}
function getById$2(id) {
  const row2 = getDb().prepare(`${SELECT_REMINDER} WHERE id = ?`).get(id);
  return row2 ? mapReminder(row2) : null;
}
function requireById$3(id) {
  const reminder = getById$2(id);
  if (!reminder) throw appError("NOT_FOUND", "提醒不存在", { detail: `id=${id}` });
  return reminder;
}
function insert$4(input) {
  try {
    getDb().prepare(
      `INSERT INTO reminders (${REMINDER_COLUMNS.join(", ")})
         VALUES (${placeholders(REMINDER_COLUMNS.length)})`
    ).run(...reminderInsertParams(input));
  } catch (e) {
    throw wrapWriteError(e, "提醒写入失败（同一任务同一偏移已存在）");
  }
  return requireById$3(input.id);
}
function replaceForTask(taskId, rows) {
  tx(() => {
    const db = getDb();
    db.prepare(
      `DELETE FROM reminders WHERE task_id = ? AND status IN ('active','paused','failed')`
    ).run(taskId);
    for (const row2 of rows) {
      db.prepare(
        `INSERT INTO reminders (${REMINDER_COLUMNS.join(", ")})
         VALUES (${placeholders(REMINDER_COLUMNS.length)})`
      ).run(...reminderInsertParams({ ...row2, taskId }));
    }
  });
  return listByTask(taskId);
}
function maxActiveAbsoluteFireAt(taskId) {
  const row2 = getDb().prepare(
    `SELECT MAX(fire_at) AS fire_at FROM reminders
       WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
  ).get(taskId);
  return row2?.fire_at ?? null;
}
function ensureRepeatRows(taskId, rule, clock, rows) {
  tx(() => {
    const db = getDb();
    db.prepare(
      `DELETE FROM reminders
       WHERE task_id = ? AND status IN ('active','paused') AND offset_min IS NULL
         AND (repeat_rule IS NULL OR repeat_rule <> ?)`
    ).run(taskId, rule);
    const absolute = db.prepare(
      `SELECT fire_at FROM reminders
         WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
    ).all(taskId);
    if (absolute.length > 0) {
      const hasClock = absolute.some((row2) => {
        const at = new Date(row2.fire_at);
        const hh = String(at.getHours()).padStart(2, "0");
        const mm = String(at.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}` === clock;
      });
      if (!hasClock) {
        db.prepare(
          `DELETE FROM reminders
           WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
        ).run(taskId);
      }
    }
    const existing = new Set(
      db.prepare(
        `SELECT fire_at FROM reminders
           WHERE task_id = ? AND offset_min IS NULL AND status IN ('active','paused')`
      ).all(taskId).map((row2) => row2.fire_at)
    );
    const insertSql = `INSERT INTO reminders (${REMINDER_COLUMNS.join(", ")})
       VALUES (${placeholders(REMINDER_COLUMNS.length)})`;
    for (const row2 of rows) {
      if (existing.has(row2.fireAt)) continue;
      db.prepare(insertSql).run(...reminderInsertParams({ ...row2, taskId }));
      existing.add(row2.fireAt);
    }
  });
  return listByTask(taskId);
}
function removePendingByTask(taskId) {
  return getDb().prepare("DELETE FROM reminders WHERE task_id = ? AND status IN ('active','paused')").run(taskId).changes;
}
function purgeForInactiveTasks() {
  return getDb().prepare(
    `DELETE FROM reminders
       WHERE status IN ('active','paused')
         AND task_id IN (SELECT id FROM tasks WHERE status IN ('discarded','archived'))`
  ).run().changes;
}
function cancel(id) {
  const changes = getDb().prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status != 'fired'").run(id).changes;
  if (changes === 0) {
    requireById$3(id);
    throw appError("CONFLICT", "这条提醒已经触发，无法取消", { detail: `id=${id}` });
  }
}
function snooze(id, fireAt) {
  const changes = getDb().prepare("UPDATE reminders SET fire_at = ?, status = 'active' WHERE id = ?").run(fireAt, id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "提醒不存在", { detail: `id=${id}` });
  return requireById$3(id);
}
function markFired$1(id, channels, firedAt) {
  const changes = getDb().prepare(
    `UPDATE reminders
       SET status = 'fired', last_fired_at = ?, fired_channels_json = ?
       WHERE id = ?`
  ).run(firedAt, JSON.stringify(channels), id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "提醒不存在", { detail: `id=${id}` });
  return requireById$3(id);
}
function markFailed(id, reason) {
  const changes = getDb().prepare("UPDATE reminders SET status = 'failed', fail_reason = ? WHERE id = ?").run(reason, id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "提醒不存在", { detail: `id=${id}` });
  return requireById$3(id);
}
function countAll() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM reminders").get();
  return row2.n;
}
const reminderRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  cancel,
  countAll,
  ensureRepeatRows,
  getById: getById$2,
  insert: insert$4,
  listByTask,
  listDue,
  listUpcoming,
  markFailed,
  markFired: markFired$1,
  maxActiveAbsoluteFireAt,
  purgeForInactiveTasks,
  removePendingByTask,
  replaceForTask,
  requireById: requireById$3,
  snooze
}, Symbol.toStringTag, { value: "Module" }));
const MINUTE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/;
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_SHAPE = /^(\d{4})-(\d{2})$/;
function isMonthNumber(month) {
  return Number.isInteger(month) && month >= 1 && month <= 12;
}
function daysInMonth(year, month) {
  if (!isMonthNumber(month)) return 0;
  return new Date(year, month, 0).getDate();
}
function isCalendarDay(year, month, day) {
  if (!isMonthNumber(month)) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(year, month);
}
function duePrecisionOf(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const minute = MINUTE_SHAPE.exec(raw);
  if (minute) {
    if (!isCalendarDay(Number(minute[1]), Number(minute[2]), Number(minute[3]))) return null;
    return Number.isNaN(new Date(raw).getTime()) ? null : "minute";
  }
  const day = DAY_SHAPE.exec(raw);
  if (day) return isCalendarDay(Number(day[1]), Number(day[2]), Number(day[3])) ? "day" : null;
  const month = MONTH_SHAPE.exec(raw);
  if (month) return isMonthNumber(Number(month[2])) ? "month" : null;
  return null;
}
function dueInstant(raw) {
  const precision = duePrecisionOf(raw);
  if (precision === null) return null;
  const value = raw;
  if (precision === "minute") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (precision === "day") return new Date(year, month - 1, day, 23, 59, 59, 999);
  return new Date(year, month, 0, 23, 59, 59, 999);
}
function dueLocalDay(raw, timeZone) {
  const precision = duePrecisionOf(raw);
  if (precision === null) return null;
  const value = raw;
  if (precision === "day") return value.slice(0, 10);
  if (precision === "month") {
    const [year, month] = value.split("-").map(Number);
    return `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
  }
  return toLocalDay(new Date(value), timeZone);
}
function dueHasTime(raw) {
  return duePrecisionOf(raw) === "minute";
}
const RUBRIC_VERSION = "v0.9";
const DEFAULT_CONFIG = {
  difficultyBase: { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  deadlineBase: { easy: 2, medium: 3, hard: 5 },
  dailyBase: 1,
  streakBonus: [
    { days: 7, bonus: 5 },
    { days: 30, bonus: 10 }
  ],
  dailyCap: null
};
const QUALITY_FACTOR = {
  partial: 0.6,
  met: 1,
  exceeded: 1.15
};
function efficiencyFactor(leadHours) {
  if (leadHours === null) return 1;
  if (leadHours < 24) return 1;
  if (leadHours < 72) return 1.1;
  return 1.2;
}
function resultFactor(result) {
  if (result === "exceeded") return 1.2;
  if (result === "below") return 1;
  return 1;
}
function roundPoints(v) {
  return Math.round(v * 100) / 100;
}
function computePlannedPoints(type, difficulty, cfg = DEFAULT_CONFIG) {
  const base = type === "deadline" ? cfg.deadlineBase?.[difficulty] ?? cfg.difficultyBase[difficulty] : cfg.difficultyBase[difficulty];
  return clamp$1(roundPoints(base), 1, 100);
}
function computeAwardedPoints(input) {
  const { type, planned, quality, overdueDays } = input;
  const q = type === "event" ? 1 : QUALITY_FACTOR[quality];
  const typeCoeff = type === "deadline" ? efficiencyFactor(input.leadHours ?? null) : type === "event" ? resultFactor(input.result ?? null) : 1;
  const penalty = type === "deadline" ? Math.min(overdueDays * 2, 20) : 0;
  return clamp$1(roundPoints(planned * q * typeCoeff - penalty), 1, roundPoints(planned * 1.4));
}
function clamp$1(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
function computeDailyPoints(streakAfter, cfg = DEFAULT_CONFIG) {
  const base = cfg.dailyBase;
  const hit = cfg.streakBonus.find((m) => m.days === streakAfter) ?? null;
  return { base, bonus: hit?.bonus ?? 0, milestoneReached: hit?.days ?? null };
}
const SELECT_DAY_STAT = `SELECT ${DAY_STAT_COLUMNS.join(", ")} FROM daily_stats`;
function getDay(day) {
  assertDay(day);
  const row2 = getDb().prepare(`${SELECT_DAY_STAT} WHERE day = ?`).get(day);
  return row2 ? mapDayStat(row2) : emptyDayStat(day);
}
function monthStats$1(year, month) {
  const { from, to } = monthBounds(year, month);
  return getDb().prepare(`${SELECT_DAY_STAT} WHERE day >= ? AND day <= ? ORDER BY day ASC`).all(from, to).map(mapDayStat);
}
function addPoints(day, delta) {
  const current2 = getDay(day);
  const next = roundPoints(current2.points + delta);
  getDb().prepare(
    `INSERT INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET points = excluded.points`
  ).run(day, next, current2.tasksDone, current2.tasksCreated, current2.occurrencesDone);
}
function bumpTasksCreated(day, n = 1) {
  bumpCounter(day, "tasks_created", n);
}
function bumpTasksDone(day, n = 1) {
  bumpCounter(day, "tasks_done", n);
}
function bumpOccurrencesDone(day, n = 1) {
  bumpCounter(day, "occurrences_done", n);
}
function bumpCounter(day, column, n) {
  getDb().prepare(
    `INSERT INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, 0, 0, 0, 0)
       ON CONFLICT(day) DO UPDATE SET ${column} = daily_stats.${column} + ?`
  ).run(day, n);
}
const DUE_LOCAL_DAY_SQL = `CASE WHEN length(due_at) = 7
     THEN date(due_at || '-01', '+1 month', '-1 day')
     ELSE date(due_at, 'localtime')
END`;
function dayIndex(from, to) {
  assertDay(from, "起始日");
  assertDay(to, "结束日");
  if (from > to) throw appError("INVALID_INPUT", "日期区间起点晚于终点", { detail: `${from} > ${to}` });
  const rows = getDb().prepare(
    `SELECT ${DUE_LOCAL_DAY_SQL} AS day,
              COUNT(*)                                        AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count
       FROM tasks
       WHERE type IN ('deadline','event')
         AND due_at IS NOT NULL
         AND ${DUE_LOCAL_DAY_SQL} BETWEEN ? AND ?
         AND status NOT IN ('discarded','archived')
       GROUP BY day
       ORDER BY day ASC`
  ).all(from, to);
  return rows.map((r) => ({ day: r.day, total: r.total, doneCount: r.done_count }));
}
function dayDetail(day) {
  assertDay(day);
  const rows = getDb().prepare(
    `SELECT id, type, title, due_at, status, points_awarded, points_planned
       FROM tasks
       WHERE type IN ('deadline','event')
         AND due_at IS NOT NULL
         AND ${DUE_LOCAL_DAY_SQL} = ?
         AND status NOT IN ('discarded','archived')
       ORDER BY due_at ASC, sort_key ASC`
  ).all(day);
  return rows.map((r) => ({
    taskId: r.id,
    type: r.type,
    title: r.title,
    // 没有时刻的条目（day / month 精度）就是空串：不造 `--:--` 之类的占位符
    time: dueHasTime(r.due_at) ? isoToLocalTime(r.due_at) : "",
    dueAt: r.due_at,
    status: r.status,
    // 未完成的条目显示计划分，完成的显示实得分
    points: r.points_awarded ?? r.points_planned
  }));
}
function rebuildDailyStats() {
  const db = getDb();
  const ledgerRows = db.prepare("SELECT day, delta FROM point_ledger").all();
  const taskRows = db.prepare("SELECT created_at, completed_at, status FROM tasks").all();
  const occurrenceRows = db.prepare("SELECT day FROM task_occurrences WHERE status = 'done'").all();
  const acc = /* @__PURE__ */ new Map();
  const bucket = (day) => {
    let stat = acc.get(day);
    if (!stat) {
      stat = emptyDayStat(day);
      acc.set(day, stat);
    }
    return stat;
  };
  for (const row2 of ledgerRows) {
    const stat = bucket(row2.day);
    stat.points = roundPoints(stat.points + row2.delta);
  }
  for (const row2 of taskRows) {
    bucket(isoToLocalDay(row2.created_at)).tasksCreated += 1;
    if (row2.status === "done" && row2.completed_at) {
      bucket(isoToLocalDay(row2.completed_at)).tasksDone += 1;
    }
  }
  for (const row2 of occurrenceRows) {
    bucket(row2.day).occurrencesDone += 1;
  }
  const days = [...acc.values()].sort((a, b) => a.day < b.day ? -1 : 1);
  tx(() => {
    db.prepare("DELETE FROM daily_stats").run();
    const stmt = db.prepare(
      `INSERT INTO daily_stats (day, points, tasks_done, tasks_created, occurrences_done)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const d of days) {
      stmt.run(d.day, d.points, d.tasksDone, d.tasksCreated, d.occurrencesDone);
    }
  });
  return { days: days.length };
}
function countDays() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM daily_stats").get();
  return row2.n;
}
const statsRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  addPoints,
  bumpOccurrencesDone,
  bumpTasksCreated,
  bumpTasksDone,
  countDays,
  dayDetail,
  dayIndex,
  getDay,
  monthStats: monthStats$1,
  rebuildDailyStats
}, Symbol.toStringTag, { value: "Module" }));
function getAll() {
  const rows = getDb().prepare("SELECT key, value_json, updated_at FROM settings").all();
  const merged = cloneDefaultSettings();
  const target = merged;
  for (const row2 of rows) {
    if (!isSettingKey(row2.key)) continue;
    target[row2.key] = parseJsonColumn(row2.value_json, `settings.${row2.key}`);
  }
  return merged;
}
function get$2(key) {
  const fallback = cloneDefaultSettings()[key];
  const row2 = getDb().prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
  if (!row2) return fallback;
  return parseJsonColumn(row2.value_json, `settings.${String(key)}`);
}
function set(key, value) {
  if (!isSettingKey(key)) {
    throw appError("INVALID_INPUT", "未知的配置项", { detail: String(key) });
  }
  if (value === void 0) {
    throw appError("INVALID_INPUT", "配置值不能是 undefined", { detail: String(key) });
  }
  const json = JSON.stringify(value);
  try {
    getDb().prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(key, json, nowIso());
  } catch (e) {
    throw wrapWriteError(e, "配置写入失败");
  }
  return get$2(key);
}
function reset(key) {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}
function listOverriddenKeys() {
  const rows = getDb().prepare("SELECT key FROM settings ORDER BY key ASC").all();
  return rows.map((r) => r.key);
}
const settingRepo$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  get: get$2,
  getAll,
  listOverriddenKeys,
  reset,
  set
}, Symbol.toStringTag, { value: "Module" }));
const MAX_N = { D: 365, W: 52, M: 24, Y: 10 };
const WEEKDAY_CHAR = ["一", "二", "三", "四", "五", "六", "日"];
const DAY_MS = 864e5;
function fail() {
  throw new Error("重复规则格式不正确");
}
function isUnit(s) {
  return s === "D" || s === "W" || s === "M" || s === "Y";
}
function utc(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function isoWeekday(day) {
  const dow = new Date(utc(day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function isLeapYear(year) {
  return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}
function parseList(text, min, max) {
  const out = [];
  for (const part of text.split(",")) {
    if (!/^\d+$/.test(part)) fail();
    const value = Number(part);
    if (value < min || value > max) fail();
    out.push(value);
  }
  return uniqueSorted(out);
}
function normalize$1(rule) {
  const s = (rule ?? "").trim().toUpperCase();
  if (s === "" || s === "DAILY") return "EVERY:1:D";
  if (s.startsWith("WEEKLY:")) return `EVERY:1:W:${s.slice("WEEKLY:".length)}`;
  return s;
}
function parseRepeatRule(rule) {
  const parts = normalize$1(rule).split(":");
  if (parts.length < 3 || parts.length > 4) fail();
  if (parts[0] !== "EVERY") fail();
  if (!/^\d+$/.test(parts[1])) fail();
  const unitText = parts[2];
  if (!isUnit(unitText)) fail();
  const unit = unitText;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_N[unit]) fail();
  const base = { n, unit, weekdays: [], monthDays: [], monthDay: null };
  const selector = parts.length === 4 ? parts[3] : void 0;
  if (unit === "D") {
    if (selector !== void 0) fail();
    return base;
  }
  if (unit === "W") {
    if (selector === void 0 || selector === "") fail();
    return { ...base, weekdays: parseList(selector, 1, 7) };
  }
  if (unit === "M") {
    if (selector === void 0 || selector === "") return base;
    return { ...base, monthDays: parseList(selector, 1, 31) };
  }
  if (selector === void 0 || selector === "") return base;
  const match = /^(\d{2})-(\d{2})$/.exec(selector);
  if (match === null) fail();
  const month = Number(match[1]);
  const date = Number(match[2]);
  if (month < 1 || month > 12 || date < 1 || date > lastDayOfMonth(2e3, month)) fail();
  return { ...base, monthDay: selector };
}
function serializeRepeatRule(r) {
  const head = `EVERY:${r.n}:${r.unit}`;
  if (r.unit === "D") return head;
  if (r.unit === "W") return `${head}:${uniqueSorted(r.weekdays).join(",")}`;
  if (r.unit === "M") {
    return r.monthDays.length === 0 ? `${head}:` : `${head}:${uniqueSorted(r.monthDays).join(",")}`;
  }
  return r.monthDay === null ? `${head}:` : `${head}:${r.monthDay}`;
}
function matchesRepeatDay(rule, day, anchor2) {
  const r = parseRepeatRule(rule);
  if (day < anchor2) return false;
  const diff = (utc(day) - utc(anchor2)) / DAY_MS;
  const [dy, dm, dd] = day.split("-").map(Number);
  if (r.unit === "D") return diff % r.n === 0;
  if (r.unit === "W") {
    if (!r.weekdays.includes(isoWeekday(day))) return false;
    const monday = (s) => utc(s) - (isoWeekday(s) - 1) * DAY_MS;
    const weeks = (monday(day) - monday(anchor2)) / (7 * DAY_MS);
    return weeks % r.n === 0;
  }
  if (r.unit === "M") {
    const [ay, am] = anchor2.split("-").map(Number);
    const months = dy * 12 + dm - (ay * 12 + am);
    if (months % r.n !== 0) return false;
    const last = lastDayOfMonth(dy, dm);
    if (r.monthDays.length > 0) {
      if (r.monthDays.includes(dd)) return true;
      return dd === last && r.monthDays.some((x) => x > last);
    }
    const anchorDay = Number(anchor2.slice(8, 10));
    if (dd === anchorDay) return true;
    return dd === last && anchorDay > last;
  }
  const years = dy - Number(anchor2.slice(0, 4));
  if (years % r.n !== 0) return false;
  const md = r.monthDay ?? anchor2.slice(5);
  const target = md === "02-29" && !isLeapYear(dy) ? "02-28" : md;
  return day.slice(5) === target;
}
function describeRepeatRule(rule) {
  const r = parseRepeatRule(rule);
  if (r.unit === "D") return r.n === 1 ? "每天" : `每 ${r.n} 天`;
  if (r.unit === "W") {
    const chars = r.weekdays.map((w) => WEEKDAY_CHAR[w - 1]).join("、");
    return r.n === 1 ? `每周${chars}` : `每 ${r.n} 周的周${chars}`;
  }
  if (r.unit === "M") {
    if (r.monthDays.length === 0) {
      return r.n === 1 ? "每月同日" : `每 ${r.n} 月的同日`;
    }
    const days = r.monthDays.join("、");
    return r.n === 1 ? `每月 ${days} 日` : `每 ${r.n} 月的 ${days} 日`;
  }
  if (r.monthDay === null) {
    return r.n === 1 ? "每年同日" : `每 ${r.n} 年的同日`;
  }
  const month = Number(r.monthDay.slice(0, 2));
  const date = Number(r.monthDay.slice(3));
  return r.n === 1 ? `每年 ${month} 月 ${date} 日` : `每 ${r.n} 年的 ${month} 月 ${date} 日`;
}
const OCCURRENCE_HORIZON_MONTHS = 3;
function matchesRepeat(task, day) {
  const anchor2 = task.activeFrom ?? toLocalDay(new Date(task.createdAt));
  return matchesRepeatDay(task.repeatRule, day, anchor2);
}
function maxDay(a, b) {
  return a > b ? a : b;
}
function minDay(a, b) {
  return a < b ? a : b;
}
function ensureRange(from, to) {
  assertDay(from, "起始日");
  assertDay(to, "结束日");
  const today = todayLocalDay();
  const horizon = addMonths(today, OCCURRENCE_HORIZON_MONTHS);
  const start = maxDay(from, today);
  const end = minDay(to, horizon);
  if (start > end) return { created: 0, scannedTasks: 0, range: { from: start, to: end } };
  const dailyTasks = listDailyActive();
  const createdAt = nowIso();
  let created = 0;
  tx(() => {
    for (const task of dailyTasks) {
      const lower = maxDay(start, task.activeFrom ?? start);
      const upper = minDay(end, task.activeTo ?? end);
      if (lower > upper) continue;
      let broken = null;
      for (const day of daysBetweenInclusive(lower, upper)) {
        let hit;
        try {
          hit = matchesRepeat(task, day);
        } catch (e) {
          broken = e instanceof Error ? e.message : String(e);
          break;
        }
        if (!hit) continue;
        if (insertIfAbsent(task.id, day, createdAt)) created += 1;
      }
      if (broken !== null) {
        console.warn("[occurrence] 重复规则不可用，跳过该任务", task.id, broken);
      }
    }
  });
  return { created, scannedTasks: dailyTasks.length, range: { from: start, to: end } };
}
function listToday() {
  const today = todayLocalDay();
  ensureRange(today, today);
  return listByDay(today);
}
function listRange(from, to) {
  ensureRange(from, to);
  return listByRange(from, to);
}
function listRangeRaw(from, to) {
  return listByRange(from, to);
}
function markMissedBefore(day) {
  assertDay(day);
  return markMissedBefore$1(day, nowIso());
}
function complete(input) {
  return tx(() => {
    const occurrence = update$4(
      input.occurrence.id,
      {
        status: "done",
        pointsAwarded: input.pointsAwarded,
        completedAt: input.completedAt
      },
      input.completedAt
    );
    const task = requireById$6(occurrence.taskId);
    updateColumns(
      task.id,
      {
        streak_current: input.streakAfter,
        streak_best: Math.max(task.streakBest, input.streakAfter)
      },
      input.completedAt
    );
    bumpOccurrencesDone(occurrence.day);
    return occurrence;
  });
}
function undo(input) {
  return tx(() => {
    const occurrence = update$4(
      input.occurrence.id,
      { status: "pending", pointsAwarded: null, completedAt: null },
      nowIso()
    );
    const task = requireById$6(occurrence.taskId);
    updateColumns(task.id, { streak_current: input.streakAfter }, nowIso());
    if (input.occurrence.status === "done") bumpOccurrencesDone(occurrence.day, -1);
    return occurrence;
  });
}
function skip(input) {
  return tx(() => {
    const patch2 = {
      status: "skipped",
      pointsAwarded: null,
      completedAt: null
    };
    if (input.note !== void 0) patch2.note = input.note;
    return update$4(input.occurrence.id, patch2, nowIso());
  });
}
function plannedDays(task, from, to) {
  const lower = maxDay(from, task.activeFrom ?? from);
  const upper = minDay(to, task.activeTo ?? to);
  if (lower > upper) return [];
  return daysBetweenInclusive(lower, upper).filter((day) => matchesRepeat(task, day));
}
const CH = {
  app: {
    getBootstrap: "app:getBootstrap",
    setSetting: "app:setSetting",
    openExternal: "app:openExternal",
    showMain: "app:showMain",
    quit: "app:quit",
    /** v0.60：本机 `updates/` 目录自检（设置页那一行的手动入口也走它） */
    checkUpdate: "app:checkUpdate"
  },
  task: {
    list: "task:list",
    get: "task:get",
    promoteDraft: "task:promoteDraft",
    update: "task:update",
    transition: "task:transition",
    complete: "task:complete",
    undo: "task:undo",
    addEvidence: "task:addEvidence",
    /** v0.61：待提交卡上删掉一条选错的证据（按 `evidence` 数组下标定位） */
    removeEvidence: "task:removeEvidence",
    setRequiresEvidence: "task:setRequiresEvidence",
    reorder: "task:reorder",
    createManual: "task:createManual",
    remove: "task:remove",
    setReminderOffsets: "task:setReminderOffsets"
  },
  occurrence: {
    today: "occurrence:today",
    listByRange: "occurrence:listByRange",
    complete: "occurrence:complete",
    undo: "occurrence:undo",
    skip: "occurrence:skip"
  },
  calendar: {
    dayIndex: "calendar:dayIndex",
    dayDetail: "calendar:dayDetail"
  },
  msg: {
    send: "msg:send",
    retry: "msg:retry",
    /** v0.48：撤回/编辑共用——按轮切片、软删任务、不广播消息删除事件 */
    remove: "msg:remove",
    list: "msg:list"
  },
  attachment: {
    add: "attachment:add",
    /** v0.36：证据卡片要 mime/url 才能画缩略图或角标，缺 Attachment 时按 id 补拉 */
    get: "attachment:get"
  },
  ai: {
    confirmDraft: "ai:confirmDraft",
    rejectDrafts: "ai:rejectDrafts",
    review: "ai:review",
    health: "ai:health",
    /** v0.44（设置抽屉）：只读「有没有 key」，**不发网络请求、不做多模态探测** */
    keyStatus: "ai:keyStatus",
    /** v0.47（设置抽屉）：写 `userData/ai-key.bin`，唯一副作用是写文件 */
    setKey: "ai:setKey"
  },
  points: {
    balance: "points:balance",
    ledger: "points:ledger",
    monthStats: "points:monthStats",
    adjust: "points:adjust",
    preview: "points:preview",
    streakPreview: "points:streakPreview",
    /** v0.45 零花钱：记账 / 撤销 / 本月支出 */
    spend: "points:spend",
    spendUndo: "points:spendUndo",
    spendMonth: "points:spendMonth"
  },
  reminder: {
    listByTask: "reminder:listByTask",
    listUpcoming: "reminder:listUpcoming",
    cancel: "reminder:cancel",
    snooze: "reminder:snooze",
    syncForTask: "reminder:syncForTask",
    testChannel: "reminder:testChannel"
  },
  /** 一天内的高频周期提醒（v0.86）：四条可 invoke 通道 */
  pulse: {
    list: "pulse:list",
    create: "pulse:create",
    setEnabled: "pulse:setEnabled",
    remove: "pulse:remove"
  },
  /** 提醒确认（v0.88）：只 record 不推送，所以不塞进 notify 那个单向组 */
  alert: {
    ack: "alert:ack"
  },
  channel: {
    list: "channel:list",
    setConfig: "channel:setConfig",
    setGlobal: "channel:setGlobal"
  },
  hud: {
    setMode: "hud:setMode",
    moveTo: "hud:moveTo",
    /** 长条拖动（v0.32）：dragBegin 取左上角算抓取偏移，dragTo 发绝对坐标，end=true 落库并判形态 */
    dragBegin: "hud:dragBegin",
    dragTo: "hud:dragTo",
    setVisible: "hud:setVisible",
    getState: "hud:getState",
    /** v0.62：悬浮条温度读数（无入参，主进程现取现回，内部有 1.5s 缓存） */
    sensors: "hud:sensors"
  },
  /** 主进程 → 渲染进程的单向事件通道（DomainEvent） */
  bus: {
    event: "bus:event"
  },
  /**
   * 提醒窗口（v0.58）：主进程 → notify 渲染入口的单向推送，**不是**可 invoke 的 api 方法。
   * 与 `bus.event` 同一类，因此同样不参与 IPC 注册表的覆盖检查。
   */
  notify: {
    show: "notify:show"
  },
  /** 人物卡（v0.37）：v1 只有一张，读 + 局部改 */
  persona: {
    get: "persona:get",
    update: "persona:update"
  },
  /** 长期记忆（v0.37）：增删改查，均不广播域事件 */
  memory: {
    list: "memory:list",
    add: "memory:add",
    update: "memory:update",
    remove: "memory:remove"
  }
};
const BOOTSTRAP_MESSAGE_LIMIT = 30;
let transport = null;
function setTransport(fn) {
  transport = fn;
}
function defaultTransport(event) {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(CH.bus.event, event);
    } catch (e) {
      console.error(`[bus] 向窗口发送 ${event.type} 失败`, e);
    }
  }
}
function broadcast(event) {
  const fn = transport ?? defaultTransport;
  fn(event);
}
function appendMessage(input) {
  const normalized = {
    id: input.id ?? newId(),
    threadId: input.threadId ?? "main",
    role: input.role,
    kind: input.kind,
    contentMd: input.contentMd ?? "",
    meta: input.meta ?? { kind: "none" },
    linkedTaskId: input.linkedTaskId ?? null,
    status: input.status ?? "sent",
    mode: input.mode ?? null,
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    latencyMs: input.latencyMs ?? null,
    createdAt: input.createdAt ?? nowIso()
  };
  return insert$6(normalized);
}
function getMessage(id) {
  return getById$3(id);
}
function requireMessage(id) {
  return requireById$4(id);
}
function patchMessage(id, input) {
  return patch(id, input);
}
function recentMessages(limit = 30) {
  return listRecent$1(limit);
}
function listMessages(input = {}) {
  const limit = input.limit ?? 30;
  return input.before ? listBefore(input.before, limit) : listRecent$1(limit);
}
function recentChatMessages(limit = 20, options = {}) {
  return listRecentText(limit, options.excludeId);
}
function textMessagesAfter(afterId, limit = 200) {
  return listTextAfter(afterId, limit);
}
function attachFiles(messageId, attachmentIds) {
  attachToMessage(messageId, attachmentIds);
}
function listAttachments(messageId) {
  return listAttachments$1(messageId);
}
function insertAttachment(input) {
  return insert$8(input);
}
const COLUMNS$1 = ["id", "content_md", "kind", "source", "hits", "created_at", "updated_at"];
const SELECT$2 = `SELECT ${COLUMNS$1.join(", ")} FROM memories`;
function mapMemory(row2) {
  return {
    id: row2.id,
    contentMd: row2.content_md,
    kind: row2.kind,
    source: row2.source,
    hits: row2.hits,
    createdAt: row2.created_at,
    updatedAt: row2.updated_at
  };
}
function list$3(options = {}) {
  const limit = options.limit ?? 200;
  const rows = options.source ? getDb().prepare(`${SELECT$2} WHERE source = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(options.source, limit) : getDb().prepare(`${SELECT$2} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(limit);
  return rows.map(mapMemory);
}
function getById$1(id) {
  const row2 = getDb().prepare(`${SELECT$2} WHERE id = ?`).get(id);
  return row2 ? mapMemory(row2) : null;
}
function getByContent(contentMd) {
  const row2 = getDb().prepare(`${SELECT$2} WHERE content_md = ?`).get(contentMd);
  return row2 ? mapMemory(row2) : null;
}
function insert$3(input) {
  const id = newId();
  const now = nowIso();
  try {
    const changes = getDb().prepare(`INSERT OR IGNORE INTO memories (${COLUMNS$1.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.contentMd, input.kind, input.source, 0, now, now).changes;
    if (changes === 0) {
      const existing = getByContent(input.contentMd);
      if (existing === null) {
        throw appError("DB_ERROR", "数据库读写失败", {
          detail: `INSERT OR IGNORE 未写入但查不到已存在行：${input.contentMd}`
        });
      }
      return existing;
    }
  } catch (e) {
    throw wrapWriteError(e, "记忆写入失败");
  }
  return requireById$2(id);
}
function update$3(id, patch2) {
  const sets = [];
  const values = [];
  if (patch2.contentMd !== void 0) {
    sets.push("content_md = ?");
    values.push(patch2.contentMd);
  }
  if (patch2.kind !== void 0) {
    sets.push("kind = ?");
    values.push(patch2.kind);
  }
  if (sets.length === 0) return requireById$2(id);
  sets.push("updated_at = ?");
  values.push(nowIso());
  try {
    const changes = getDb().prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...values, id).changes;
    if (changes === 0) throw appError("NOT_FOUND", "记忆不存在", { detail: `id=${id}` });
  } catch (e) {
    throw wrapWriteError(e, "记忆写入失败");
  }
  return requireById$2(id);
}
function remove$3(id) {
  const changes = getDb().prepare("DELETE FROM memories WHERE id = ?").run(id).changes;
  if (changes === 0) throw appError("NOT_FOUND", "记忆不存在", { detail: `id=${id}` });
}
function count() {
  const row2 = getDb().prepare("SELECT COUNT(*) AS n FROM memories").get();
  return row2.n;
}
function touchHits$1(ids) {
  if (ids.length === 0) return;
  getDb().prepare(`UPDATE memories SET hits = hits + 1 WHERE id IN (${placeholders(ids.length)})`).run(...ids);
}
function evictOne() {
  const row2 = getDb().prepare("SELECT id FROM memories ORDER BY hits ASC, updated_at ASC, rowid ASC LIMIT 1").get();
  if (!row2) return null;
  getDb().prepare("DELETE FROM memories WHERE id = ?").run(row2.id);
  return row2.id;
}
function requireById$2(id) {
  const found = getById$1(id);
  if (found === null) throw appError("NOT_FOUND", "记忆不存在", { detail: `id=${id}` });
  return found;
}
const MEMORY_LIMIT = 50;
const MEMORY_MAX_CHARS = 120;
function charCount$2(text) {
  return Array.from(text).length;
}
function normalize(contentMd) {
  const text = contentMd.trim();
  if (charCount$2(text) === 0) throw appError("INVALID_INPUT", "记忆内容不能为空");
  if (charCount$2(text) > MEMORY_MAX_CHARS) throw appError("INVALID_INPUT", "记忆最多 120 个字");
  return text;
}
function list$2(input = {}) {
  return list$3({ source: input.source });
}
function addManual(input) {
  const contentMd = normalize(input.contentMd);
  const existing = getByContent(contentMd);
  if (existing !== null) return existing;
  if (count() >= MEMORY_LIMIT) {
    throw appError("INVALID_INPUT", `记忆已达 ${MEMORY_LIMIT} 条，请先删几条`);
  }
  return insert$3({ contentMd, kind: input.kind, source: "manual" });
}
function update$2(id, patch2) {
  const next = {};
  if (patch2.contentMd !== void 0) next.contentMd = normalize(patch2.contentMd);
  if (patch2.kind !== void 0) next.kind = patch2.kind;
  try {
    return update$3(id, next);
  } catch (e) {
    if (e instanceof AppErrorException && e.code === "CONFLICT") {
      throw appError("INVALID_INPUT", "这条记忆已经存在", { detail: e.detail });
    }
    throw e;
  }
}
function remove$2(id) {
  remove$3(id);
}
function touchHits(ids) {
  touchHits$1(ids);
}
function addAuto(input) {
  const text = input.contentMd.trim();
  const chars = charCount$2(text);
  if (chars === 0 || chars > MEMORY_MAX_CHARS) return null;
  if (count() >= MEMORY_LIMIT) evictOne();
  const before = getByContent(text);
  if (before !== null) return before;
  return insert$3({ contentMd: text, kind: input.kind, source: "auto" });
}
const COLUMNS = [
  "id",
  "name",
  "user_call",
  "persona_md",
  "tone",
  "is_active",
  "created_at",
  "updated_at"
];
const SELECT$1 = `SELECT ${COLUMNS.join(", ")} FROM personas`;
const TONES$1 = ["warm", "plain", "playful"];
function toneOf(raw) {
  return TONES$1.includes(raw) ? raw : "warm";
}
function mapPersona(row2) {
  return {
    id: row2.id,
    name: row2.name,
    userCall: row2.user_call,
    personaMd: row2.persona_md,
    tone: toneOf(row2.tone),
    isActive: row2.is_active === 1,
    createdAt: row2.created_at,
    updatedAt: row2.updated_at
  };
}
function getActive() {
  const row2 = getDb().prepare(`${SELECT$1} WHERE is_active = 1 ORDER BY created_at ASC, rowid ASC LIMIT 1`).get();
  return row2 ? mapPersona(row2) : null;
}
function list$1() {
  const rows = getDb().prepare(`${SELECT$1} ORDER BY created_at ASC, rowid ASC`).all();
  return rows.map(mapPersona);
}
function insertDefault() {
  const now = nowIso();
  try {
    getDb().prepare(
      `INSERT INTO personas (${COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("default", "小助手", "", "", "warm", 1, now, now);
  } catch (e) {
    throw wrapWriteError(e, "人物卡写入失败");
  }
  return requireById$1("default");
}
function update$1(id, patch2) {
  const sets = [];
  const values = [];
  if (patch2.name !== void 0) {
    sets.push("name = ?");
    values.push(patch2.name);
  }
  if (patch2.userCall !== void 0) {
    sets.push("user_call = ?");
    values.push(patch2.userCall);
  }
  if (patch2.personaMd !== void 0) {
    sets.push("persona_md = ?");
    values.push(patch2.personaMd);
  }
  if (patch2.tone !== void 0) {
    sets.push("tone = ?");
    values.push(patch2.tone);
  }
  if (sets.length === 0) return requireById$1(id);
  sets.push("updated_at = ?");
  values.push(nowIso());
  try {
    const changes = getDb().prepare(`UPDATE personas SET ${sets.join(", ")} WHERE id = ?`).run(...values, id).changes;
    if (changes === 0) throw appError("NOT_FOUND", "人物卡不存在", { detail: `id=${id}` });
  } catch (e) {
    throw wrapWriteError(e, "人物卡写入失败");
  }
  return requireById$1(id);
}
function setActive(id) {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare("UPDATE personas SET is_active = 0 WHERE id <> ?").run(id);
    const changes = db.prepare("UPDATE personas SET is_active = 1, updated_at = ? WHERE id = ?").run(nowIso(), id).changes;
    if (changes === 0) throw appError("NOT_FOUND", "人物卡不存在", { detail: `id=${id}` });
  });
  try {
    run();
  } catch (e) {
    throw wrapWriteError(e, "人物卡写入失败");
  }
}
function requireById$1(id) {
  const row2 = getDb().prepare(`${SELECT$1} WHERE id = ?`).get(id);
  if (!row2) throw appError("NOT_FOUND", "人物卡不存在", { detail: `id=${id}` });
  return mapPersona(row2);
}
const TONES = ["warm", "plain", "playful"];
function charCount$1(text) {
  return Array.from(text).length;
}
function get$1() {
  const active = getActive();
  if (active !== null) return active;
  const any = list$1()[0];
  if (any !== void 0) {
    setActive(any.id);
    return requireById$1(any.id);
  }
  return insertDefault();
}
function update(patch2) {
  const current2 = get$1();
  const next = {};
  if (patch2.name !== void 0) {
    const name2 = patch2.name.trim();
    if (charCount$1(name2) === 0) throw appError("INVALID_INPUT", "助手名字不能为空");
    if (charCount$1(name2) > 20) throw appError("INVALID_INPUT", "助手名字最多 20 个字");
    next.name = name2;
  }
  if (patch2.userCall !== void 0) {
    const userCall = patch2.userCall.trim();
    if (charCount$1(userCall) > 20) throw appError("INVALID_INPUT", "称呼最多 20 个字");
    next.userCall = userCall;
  }
  if (patch2.personaMd !== void 0) {
    if (charCount$1(patch2.personaMd) > 800) throw appError("INVALID_INPUT", "人设最多 800 个字");
    next.personaMd = patch2.personaMd;
  }
  if (patch2.tone !== void 0) {
    next.tone = TONES.includes(patch2.tone) ? patch2.tone : "warm";
  }
  return update$1(current2.id, next);
}
function logName(raw) {
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}
const BASE64_PRECHECK_SLACK = 64;
function assertSize(size, label) {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw appError("FILE_TOO_LARGE", `附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 上限`, {
      detail: `${label} 为 ${size} 字节`
    });
  }
  if (size <= 0) {
    throw appError("INVALID_INPUT", "附件内容为空", { detail: `${label} 为 0 字节` });
  }
  return size;
}
function fromSourcePath(sourcePath) {
  let stat;
  try {
    stat = node_fs.statSync(sourcePath);
  } catch (e) {
    throw appError("INVALID_INPUT", "附件源文件不存在或不可读", {
      detail: `${sourcePath}：${e instanceof Error ? e.message : String(e)}`,
      cause: e
    });
  }
  if (!stat.isFile()) {
    throw appError("INVALID_INPUT", "附件源路径不是普通文件", { detail: sourcePath });
  }
  return { kind: "file", sourcePath, size: assertSize(stat.size, "源文件") };
}
function decodeBase64(raw) {
  const trimmed = raw.trim();
  const marker = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const payload = (marker >= 0 ? trimmed.slice(marker + 1) : trimmed).replace(/\s+/g, "");
  if (payload.length === 0) {
    throw appError("INVALID_INPUT", "附件内容为空", { detail: "base64 为空" });
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    throw appError("INVALID_INPUT", "附件内容不是合法的 base64", {
      detail: `长度为 ${payload.length}`
    });
  }
  return Buffer.from(payload, "base64");
}
function resolvePayload(input) {
  const hasSource = typeof input.sourcePath === "string" && input.sourcePath.length > 0;
  const hasBase64 = typeof input.base64 === "string" && input.base64.length > 0;
  if (hasSource) return fromSourcePath(input.sourcePath);
  if (hasBase64) {
    const raw = input.base64;
    if (raw.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + BASE64_PRECHECK_SLACK) {
      throw appError("FILE_TOO_LARGE", `附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 上限`, {
        detail: `base64 串长约 ${raw.length} 字符，解码后必超上限`
      });
    }
    const buffer = decodeBase64(raw);
    return { kind: "buffer", buffer, size: assertSize(buffer.byteLength, "base64 解码结果") };
  }
  throw appError("INVALID_INPUT", "附件缺少内容：sourcePath 与 base64 至少给一个");
}
function sha256Of(payload) {
  const hash = node_crypto.createHash("sha256");
  if (payload.kind === "buffer") {
    hash.update(payload.buffer);
  } else {
    hash.update(node_fs.readFileSync(payload.sourcePath));
  }
  return hash.digest("hex");
}
function isStored(absPath, size) {
  if (!node_fs.existsSync(absPath)) return false;
  try {
    return node_fs.statSync(absPath).size === size;
  } catch {
    return false;
  }
}
function writeAtomically(absPath, tag, payload) {
  const tmp = `${absPath}.${tag}.part`;
  try {
    node_fs.mkdirSync(node_path.dirname(absPath), { recursive: true });
    if (payload.kind === "file") node_fs.copyFileSync(payload.sourcePath, tmp);
    else node_fs.writeFileSync(tmp, payload.buffer);
    node_fs.renameSync(tmp, absPath);
  } catch (e) {
    try {
      node_fs.rmSync(tmp, { force: true });
    } catch {
    }
    throw appError("IO_ERROR", "附件写入磁盘失败", {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    });
  }
}
function add(input) {
  const rawName = typeof input?.name === "string" ? input.name : "";
  const rawMime = typeof input?.mime === "string" ? input.mime : "";
  const mime = normalizeMime(rawMime);
  extForMime(mime);
  const payload = resolvePayload(input);
  const sha256 = sha256Of(payload);
  const id = newId();
  const existing = findBySha(sha256, mime);
  const relPath = existing ? existing.rel_path : attachmentRelPath(id, mime);
  const absPath = resolveWithinRoot(attachmentRoot(), relPath);
  if (!absPath) {
    throw appError("INVALID_INPUT", "附件存放路径非法", { detail: `rel_path=${relPath}` });
  }
  if (!isStored(absPath, payload.size)) writeAtomically(absPath, id, payload);
  console.log(
    `[attachment] add ${logName(rawName) || "(未命名)"} → ${relPath} (${mime}, ${payload.size}B)`
  );
  return insert$8({
    id,
    messageId: null,
    taskId: null,
    kind: kindForMime(mime),
    relPath,
    mime,
    bytes: payload.size,
    width: null,
    height: null,
    sha256,
    createdAt: nowIso(),
    // 落库的是**清洗后**的名字（v0.49 §2.3）；日志仍用 logName，两者用途不同
    name: displayName(rawName, mime)
  });
}
function read(id) {
  if (!isAttachmentId(id)) {
    throw appError("NOT_FOUND", "附件不存在", { detail: `id 形状不合法：${JSON.stringify(id)}` });
  }
  const row2 = attachmentRowById(id);
  if (!row2) throw appError("NOT_FOUND", "附件不存在", { detail: `id=${id}` });
  const absPath = resolveWithinRoot(attachmentRoot(), row2.rel_path);
  if (!absPath)
    throw appError("NOT_FOUND", "附件不存在", { detail: `rel_path 越界：${row2.rel_path}` });
  try {
    return { bytes: node_fs.readFileSync(absPath), mime: row2.mime };
  } catch (e) {
    const code = e?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw appError("NOT_FOUND", "附件文件已丢失", { detail: row2.rel_path, cause: e });
    }
    throw appError("IO_ERROR", "附件读取失败", {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    });
  }
}
const AI_COPY = {
  /** AI_NOT_CONFIGURED：没配 Key，重试也没用 → retryable: false */
  notConfigured: "模型 Key 还没配置",
  /** AI_UPSTREAM_ERROR：网络/5xx/超时，等一会儿可能就好 → retryable: true */
  upstream: "模型服务暂时没有响应，稍后再试",
  /** AI_RATE_LIMITED：限流 → retryable: true */
  rateLimited: "模型调用太频繁，稍后再试",
  /** AI_PARSE_FAILED：拿到回复但读不懂 → retryable: true（用户点重试有意义） */
  parseFailed: "这次没读懂模型的回复，再试一次",
  /** 硬闸门命中时审核卡的 reason 行（followup 会盖在 reason 位置上显示，04 §3.3） */
  needEvidenceReason: "还没有看到能证明完成的凭据",
  /** 硬闸门命中时的追问。不指定具体要什么文件，因为不同任务要的东西不一样 */
  needEvidenceFollowup: "发一张截图或文件，我按它判",
  /** 一次超过 4 张图时拼在 reply 末尾（开工词 §4.6：丢掉多的、在 reply 里说明，不报错） */
  imagesDropped: "（一次最多看 4 张图，多出来的没看）"
};
class AiAbortedError extends Error {
  constructor(message = "已取消") {
    super(message);
    this.name = "AiAbortedError";
  }
}
function isAbortError(e) {
  if (e instanceof AiAbortedError) return true;
  const name2 = e?.name;
  return name2 === "AbortError" || name2 === "AiAbortedError";
}
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const ENDPOINT_PATH = "/chat/completions";
const AI_TIMEOUT_MS = 18e4;
const AI_MAX_TOKENS = 1e4;
const ECHO_LIMIT = 2e3;
const BODY_LIMIT = 200;
function endpointOf(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const base = (trimmed.length === 0 ? GLM_BASE_URL : trimmed).replace(/\/+$/, "");
  if (base.endsWith(ENDPOINT_PATH)) return base;
  return `${base}${ENDPOINT_PATH}`;
}
function stripFence(raw) {
  let text = raw.trim();
  if (!text.startsWith("```")) return text;
  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1) {
    return text.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  }
  text = text.slice(firstBreak + 1);
  const trimmedEnd = text.trimEnd();
  if (trimmedEnd.endsWith("```")) {
    text = trimmedEnd.slice(0, trimmedEnd.lastIndexOf("```"));
  }
  return text.trim();
}
function parseOnce(content, schema) {
  const stripped = stripFence(content);
  if (stripped.length === 0) return { ok: false, reason: "输出为空" };
  let raw;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`).join("; ");
  return { ok: false, reason: `字段不符合要求（${issues}）` };
}
function scrub(text, apiKey) {
  if (!apiKey) return text;
  let out = text.split(apiKey).join("[key]");
  const head = apiKey.slice(0, 6);
  if (head.length === 6) out = out.split(head).join("[key]");
  return out;
}
function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
class GlmClient {
  apiKey;
  model;
  baseUrl;
  timeoutMs;
  maxTokens;
  fetchImpl;
  constructor(options) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = endpointOf(options.baseUrl ?? GLM_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? AI_MAX_TOKENS;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }
  async chatJson(opts) {
    const started = Date.now();
    const maxRetries = opts.maxRetries ?? 1;
    let messages = [...opts.messages];
    let lastReason = "输出不符合要求";
    let lastContent = "";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const outcome = await this.request(messages, {
        ...opts,
        reasoningEffort: opts.reasoningEffort === void 0 ? void 0 : attempt === 0 ? opts.reasoningEffort : "high"
      });
      lastContent = outcome.content;
      if (outcome.finishReason === "length") {
        throw appError("AI_PARSE_FAILED", AI_COPY.parseFailed, {
          retryable: true,
          detail: `finish_reason=length（content ${outcome.content.length} 字符，out=${outcome.usage.out} tokens）`
        });
      }
      const parsed = parseOnce(outcome.content, opts.schema);
      if (parsed.ok) {
        return {
          data: parsed.data,
          usage: outcome.usage,
          latencyMs: Date.now() - started
        };
      }
      lastReason = parsed.reason;
      if (attempt < maxRetries) {
        messages = [
          ...messages,
          { role: "assistant", content: truncate(outcome.content, ECHO_LIMIT) },
          {
            role: "user",
            content: `上一次的输出没有通过校验：${lastReason}
请重新只输出一个 JSON 对象，不要 markdown 围栏，不要解释，不要补充任何额外字段。`
          }
        ];
      }
    }
    throw appError("AI_PARSE_FAILED", AI_COPY.parseFailed, {
      retryable: true,
      detail: scrub(
        `${lastReason}（已重试 ${maxRetries} 次；末次输出 ${truncate(lastContent, 80)}）`,
        this.apiKey
      )
    });
  }
  /**
   * `chatText`：纯文本回复（03 §3.1 v0.37、v0.56）。
   *
   * 与 `chatJson` 只差三处：body 不带 `response_format`、结果不解析 JSON、
   * 只做「剥围栏 → trim → 空串报 AI_PARSE_FAILED」。**`chatJson` 的实现一个字没动。**
   *
   * v0.56：空正文**原样重发一次**（最多 2 次请求）。空正文不是格式错，没有 issues 可回授，
   * 改 prompt 只会引入不确定性；`finish_reason === 'length'` 不重试（同样的预算得到同样的截断，
   * 与 `chatJson` §2.2 同一原则）。两次的 tokens 相加落库，`latencyMs` 从第一次请求发起算起。
   */
  async chatText(opts) {
    const started = Date.now();
    const maxAttempts = 2;
    let usage = { in: 0, out: 0 };
    let lastFinish = "unknown";
    let lastLength = 0;
    let attempted = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const outcome = await this.requestText(opts.messages, opts);
      attempted += 1;
      usage = { in: usage.in + outcome.usage.in, out: usage.out + outcome.usage.out };
      lastFinish = outcome.finishReason;
      lastLength = outcome.content.length;
      const text = stripFence(outcome.content).trim();
      if (text.length > 0) {
        return { text, usage, latencyMs: Date.now() - started };
      }
      if (outcome.finishReason === "length") break;
    }
    throw appError("AI_PARSE_FAILED", AI_COPY.parseFailed, {
      retryable: true,
      detail: `chatText 输出为空（finish_reason=${lastFinish}，正文 ${lastLength} 字符，已重试 ${attempted - 1} 次）`
    });
  }
  /** 一次 HTTP 往返（纯文本）。超时/鉴权/状态码映射与 `request` 同一套口径 */
  async requestText(messages, opts) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? this.maxTokens
    };
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      if (opts.signal?.aborted && !timedOut) throw new AiAbortedError();
      if (timedOut) {
        throw appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, {
          retryable: true,
          detail: `请求超时（${this.timeoutMs}ms）`
        });
      }
      throw appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, {
        retryable: true,
        detail: scrub(e instanceof Error ? e.message : String(e), this.apiKey)
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (!response.ok) throw await this.httpError(response);
    let payload;
    try {
      payload = await response.json();
    } catch (e) {
      throw appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, {
        retryable: true,
        detail: `响应体不是 JSON（${e instanceof Error ? e.message : String(e)}）`
      });
    }
    return this.readOutcome(payload, true);
  }
  /** 一次 HTTP 往返。鉴权、超时、状态码映射都在这里，失败一律抛 AppErrorException */
  async request(messages, opts) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
      // v0.52：不传就不发这个字段，保持上游默认（max）。`glm-5.3-flash` 不支持 disabled
      ...opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}
    };
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      if (opts.signal?.aborted && !timedOut) throw new AiAbortedError();
      if (timedOut) {
        throw appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, {
          retryable: true,
          detail: `请求超时（${this.timeoutMs}ms）`
        });
      }
      throw appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, {
        retryable: true,
        detail: scrub(e instanceof Error ? e.message : String(e), this.apiKey)
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (!response.ok) throw await this.httpError(response);
    let payload;
    try {
      payload = await response.json();
    } catch (e) {
      throw appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, {
        retryable: true,
        detail: `响应体不是 JSON（${e instanceof Error ? e.message : String(e)}）`
      });
    }
    return this.readOutcome(payload);
  }
  /** 上游状态码 → 业务错误码（开工词 §4.2） */
  async httpError(response) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      detail = scrub(`${detail} ${truncate(text, BODY_LIMIT)}`, this.apiKey);
    } catch {
    }
    const status = response.status;
    if (status === 401 || status === 403) {
      return appError("AI_NOT_CONFIGURED", AI_COPY.notConfigured, { retryable: false, detail });
    }
    if (status === 429) {
      return appError("AI_RATE_LIMITED", AI_COPY.rateLimited, { retryable: true, detail });
    }
    if (status >= 500) {
      return appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, { retryable: true, detail });
    }
    return appError("AI_UPSTREAM_ERROR", AI_COPY.upstream, { retryable: false, detail });
  }
  /**
   * 从响应体里取 `content` / `finish_reason` / `usage`。`reasoning_content` 读都不读。
   *
   * `allowEmpty`：只有 `requestText`（`chatText`）传 true——它要自己拿空正文去做"重试一次"的判定，
   * 不能被这里抢先抛错。`chatJson` 那条路径照旧（默认 false，行为一个字不变）。
   */
  readOutcome(payload, allowEmpty = false) {
    const root2 = payload;
    const choice = root2?.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown";
    const usage = {
      in: typeof root2?.usage?.prompt_tokens === "number" ? root2.usage.prompt_tokens : 0,
      // 含推理 token：上游把 reasoning_tokens 算在 completion_tokens 里（03 §9.1）
      out: typeof root2?.usage?.completion_tokens === "number" ? root2.usage.completion_tokens : 0
    };
    if (!allowEmpty && content.length === 0 && finishReason !== "length") {
      throw appError("AI_PARSE_FAILED", AI_COPY.parseFailed, {
        retryable: true,
        detail: `content 为空（finish_reason=${finishReason}）`
      });
    }
    return { content, finishReason, usage };
  }
}
const ENV_NAME = "ZHIPU_API_KEY";
const KEY_FILE = "ai-key.bin";
const ENV_LOCAL_FILE = ".env.local";
let warned = false;
function hasApp() {
  return typeof electron.app === "object" && electron.app !== null && typeof electron.app.getPath === "function";
}
function userDataDir() {
  if (!hasApp()) return null;
  try {
    return electron.app.getPath("userData");
  } catch {
    return null;
  }
}
function encryptionAvailable() {
  if (typeof electron.safeStorage !== "object" || electron.safeStorage === null) return false;
  try {
    return electron.safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[ai/config] ${message}`);
}
function readEncryptedKey() {
  const dir = userDataDir();
  if (dir === null) return null;
  const file = node_path.join(dir, KEY_FILE);
  if (!node_fs.existsSync(file)) return null;
  if (!encryptionAvailable()) {
    warnOnce("safeStorage 不可用，跳过加密文件，降级到环境变量");
    return null;
  }
  try {
    const plain = electron.safeStorage.decryptString(node_fs.readFileSync(file));
    const trimmed = plain.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    warnOnce(`加密文件无法解密，已忽略（${e instanceof Error ? e.name : "unknown"}）`);
    return null;
  }
}
function readDevEnvFile() {
  if (!hasApp()) return null;
  if (electron.app.isPackaged !== false) return null;
  let root2;
  try {
    root2 = electron.app.getAppPath();
  } catch {
    return null;
  }
  const file = node_path.join(root2, ENV_LOCAL_FILE);
  if (!node_fs.existsSync(file)) return null;
  let text;
  try {
    text = node_fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== ENV_NAME) continue;
    return unquote(line.slice(eq + 1).trim()) || null;
  }
  return null;
}
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
function readKey() {
  const encrypted = readEncryptedKey();
  if (encrypted !== null) return encrypted;
  const fromEnv = (process.env[ENV_NAME] ?? "").trim();
  if (fromEnv.length > 0) return fromEnv;
  return readDevEnvFile();
}
function writeKey(key) {
  const trimmed = key.trim();
  if (trimmed.length === 0) return false;
  const dir = userDataDir();
  if (dir === null) {
    warnOnce("没有可用的 userData 目录，Key 未写入");
    return false;
  }
  if (!encryptionAvailable()) {
    warnOnce("safeStorage 不可用，拒绝写入明文 Key");
    return false;
  }
  const file = node_path.join(dir, KEY_FILE);
  node_fs.mkdirSync(node_path.dirname(file), { recursive: true });
  node_fs.writeFileSync(file, electron.safeStorage.encryptString(trimmed), { mode: 384 });
  return true;
}
const weekdayFormatters = /* @__PURE__ */ new Map();
const clockFormatters = /* @__PURE__ */ new Map();
function weekdayFormatter(timeZone) {
  const key = timeZone ?? "";
  let f = weekdayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
    weekdayFormatters.set(key, f);
  }
  return f;
}
function clockFormatter(timeZone) {
  const key = timeZone ?? "";
  let f = clockFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    clockFormatters.set(key, f);
  }
  return f;
}
const WEEKDAY_BY_SHORT = {
  Sun: "星期日",
  Mon: "星期一",
  Tue: "星期二",
  Wed: "星期三",
  Thu: "星期四",
  Fri: "星期五",
  Sat: "星期六"
};
function weekdayOf$1(now, timeZone) {
  const short = weekdayFormatter(timeZone).format(now);
  return WEEKDAY_BY_SHORT[short] ?? short;
}
function clockOf(now, timeZone) {
  const parts = clockFormatter(timeZone).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}
function zoneLabel(timeZone) {
  if (timeZone) return timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}
function buildNowHint(now = /* @__PURE__ */ new Date(), timeZone) {
  const day = toLocalDay(now, timeZone);
  const weekday = weekdayOf$1(now, timeZone);
  const clock = clockOf(now, timeZone);
  return `【当前时间】${day} ${weekday} ${clock}（${zoneLabel(timeZone)}）
解析"明天/下周三/三小时后"这类相对时间时，一律以此为准，并换算成带时区的 ISO8601。`;
}
let cachedKey = "";
let cachedHint = "";
function nowHint(now = /* @__PURE__ */ new Date(), timeZone) {
  const key = `${toLocalDay(now, timeZone)}T${clockOf(now, timeZone)}|${zoneLabel(timeZone)}`;
  if (key !== cachedKey) {
    cachedHint = buildNowHint(now, timeZone);
    cachedKey = key;
  }
  return cachedHint;
}
const chatSystem = "<!-- v1 2026-10-31 · 03 §4.3.1 第 5 段，逐字写死，不要改写 -->\n规则：\n- 用中文，口语，不要分点罗列，不要输出 JSON 或 markdown 代码块。\n- 只说你确定的事。不知道就说不知道，不要编数字、编日期、编你做过的事。\n- 你现在处在聊天模式，不能创建、修改、完成任何任务。用户让你记任务时，如实告诉他这个模式不能建任务，不要假装记下了。\n- 不要复述上面「关于对方，你记得这些」和「今天」的原文，把它们当成你已经知道的事自然使用。\n";
const version$1 = "v1 2026-10-29";
const note = "五组正例：单任务 / 图转任务 / 多任务（含一条 event 正例）/ 只有月份 / 纯闲聊。日期按「当前时间 = 2026-10-29 星期四」书写，仅示意格式。示例 2 / 3 演示只有日期、示例 4 演示只有月份，一律不补时刻。";
const examples = [
  {
    label: "单任务：有明确截止时间",
    user: "明天下午三点前把季度报告初稿写完",
    assistant: {
      intent: "create_task",
      reply: "记成限时任务了，截止按明天下午三点填。写完把文件发我。",
      tasks: [
        {
          type: "deadline",
          title: "写季度报告初稿",
          detail_md: "把本季度数据整理进模板，输出初稿文件，供后续评审。",
          requires_evidence: true,
          difficulty: "medium",
          estimate_min: 90,
          due_hint: "2026-10-30T15:00:00+08:00",
          daily_time_hint: null,
          tags: [
            "工作"
          ],
          steps: [
            {
              title: "整理本季度数据",
              estimate_min: 30
            },
            {
              title: "套模板写初稿",
              estimate_min: 60
            }
          ],
          missing_info: [],
          confidence: 0.9
        }
      ]
    }
  },
  {
    label: "图转任务：截图里的一句话",
    user: "【用户发来一张图片，内容是白板上的手写字：「周五前把报销单交财务」】",
    assistant: {
      intent: "create_task",
      reply: "白板上这句记下来了，截止记成这周五。",
      tasks: [
        {
          type: "deadline",
          title: "交报销单给财务",
          detail_md: "把本月的报销单整理好，交给财务。",
          requires_evidence: true,
          difficulty: "easy",
          estimate_min: 30,
          due_hint: "2026-10-30",
          daily_time_hint: null,
          tags: [
            "工作"
          ],
          steps: [],
          missing_info: [],
          confidence: 0.85
        }
      ]
    }
  },
  {
    label: "多任务：一条 event + 一条 deadline（event 正例，考试不要判成 deadline）",
    user: "下周三考英语六级，另外这周五前要把实验报告交了",
    assistant: {
      intent: "create_task",
      reply: "记了两件：下周三的六级考试，和这周五前交实验报告。",
      tasks: [
        {
          type: "event",
          title: "参加英语六级考试",
          detail_md: "下周三上午到场参加英语六级考试。考前把证件和耳机准备好。",
          requires_evidence: true,
          difficulty: "hard",
          estimate_min: 150,
          due_hint: "2026-11-04",
          daily_time_hint: null,
          tags: [
            "学习"
          ],
          steps: [],
          missing_info: [],
          confidence: 0.88
        },
        {
          type: "deadline",
          title: "交实验报告",
          detail_md: "把实验报告整理定稿并提交。",
          requires_evidence: true,
          difficulty: "medium",
          estimate_min: 120,
          due_hint: "2026-10-30",
          daily_time_hint: null,
          tags: [
            "学习"
          ],
          steps: [],
          missing_info: [],
          confidence: 0.9
        }
      ]
    }
  },
  {
    label: "只有月份：不补日期、不补时刻",
    user: "11月要交学费",
    assistant: {
      intent: "create_task",
      reply: "记成 11 月的限时任务了，具体哪天交你知道了再改。",
      tasks: [
        {
          type: "deadline",
          title: "交学费",
          detail_md: "在本月内完成学费缴纳。",
          requires_evidence: true,
          difficulty: "easy",
          estimate_min: 20,
          due_hint: "2026-11",
          daily_time_hint: null,
          tags: [
            "生活"
          ],
          steps: [],
          missing_info: [
            "具体哪天截止？"
          ],
          confidence: 0.8
        }
      ]
    }
  },
  {
    label: "纯闲聊：不建任务",
    user: "今天天气不错",
    assistant: {
      intent: "chat",
      reply: "是挺好的，适合出去走走。",
      tasks: []
    }
  }
];
const fewshot = {
  version: version$1,
  note,
  examples
};
const parseSystem = '<!-- v1 2026-10-29 -->\n# 这一轮的输出形状\n\n严格按这个形状输出，**不多一个键，不少一个键**：\n\n```json\n{\n  "intent": "create_task | review_task | query | chat",\n  "reply": "对用户说的一句话",\n  "tasks": [\n    {\n      "type": "daily | deadline | event",\n      "title": "动词开头的短标题",\n      "detail_md": "补全后可直接执行的任务描述",\n      "requires_evidence": true,\n      "difficulty": "trivial | easy | medium | hard | epic",\n      "estimate_min": 30,\n      "due_hint": "2026-10-30T15:00:00+08:00",\n      "daily_time_hint": "21:00",\n      "tags": ["工作"],\n      "steps": [{ "title": "步骤", "estimate_min": 10 }],\n      "missing_info": ["需要用户补充的信息"],\n      "confidence": 0.86\n    }\n  ]\n}\n```\n\n- `due_hint`、`daily_time_hint` 不需要时填 `null`；`estimate_min` 不知道就填 `null`；\n  `steps`、`tags`、`missing_info` 没有就填 `[]`。\n- `reply` 一句话，不超过 60 字。\n- `title` 动词开头（"写""交""约""查""背"），不超过 24 字，不要带书名号或引号。\n\n# 硬约束（逐条都必须满足）\n\n## 1. 一次最多 10 个任务\n\n用户一口气说了一堆事，最多抽 10 件——挑最要紧、最有明确产出的那几件。\n超过 10 件时，先抽 10 件，并在 `reply` 里说一句"先记了 10 件，剩下的要不要也加上"。\n**不要**为了凑数把一件事拆成几件；也**不要**因为数量多就漏掉明显独立的事项。\n\n## 2. 不臆造，但已知的粒度必须填\n\n`due_hint` 按你**真实知道**的粒度填，不要为了凑格式补时刻：\n\n| 你知道的 | 填法 | 例 |\n|---|---|---|\n| 具体几点 | 完整时间 | `2026-11-05T15:00:00+08:00` |\n| 只有哪一天 | 只写日期 | `2026-11-05` |\n| 只有哪个月 | 只写年月 | `2026-11` |\n| 连哪个月都不知道 | `null` | — |\n\n**禁止**把"只有日期"补成带时刻的形式——`T00:00`、`T09:00`、`T23:59` 都是编的。\n填 `null` 的唯一条件是**连月份都推不出来**。\n不要"一般这种事都是周五交"就填一个周五——填错日期比留空糟得多。\n\n## 3. 信息不足时暴露它，不要补全它\n\n缺什么写进 `missing_info`（每条一句问句，不超过 30 字），并把 `confidence` 压到 0.5 以下。\n`detail_md` 只能写"从用户的话里能推出来的执行步骤"，不能替他决定预算、人数、场地、交付格式。\n\n## 4. 任务类型怎么判（这条决定提醒时刻，判错等于提醒全错）\n\n| type | 判定信号 | 不要归到这里 |\n|---|---|---|\n| `daily` | 含"每天/每日/坚持/养成/打卡"，或周期性重复的自我训练 | 一次性的事 |\n| `deadline` | 有明确交付物 + 一个截止时间（"X 号前交""周五之前写完"；作业/报告/论文/报名/缴费） | 只是"要做"、连月份都没有 → **仍是 `deadline`**，但 `due_hint` 填 `null` |\n| `event` | 在**某个时刻发生**、需要提前准备、你本人要到场：考试 / 面试 / 答辩 / 会议 / 体检 / 竞赛 / 演出 | 需要你产出东西的事 → `deadline` |\n\n**"要我到场"≠"要我交东西"。** "下周三考英语六级"是 event（那个时刻你去考试），\n不是 deadline（没有交付物）。"下周五前交实验报告"是 deadline（有交付物，时间只是截止）。\n\n判断不清时默认 `deadline`：它只在前一天和前一小时催你，即使判错打扰也最小；\n`event` 会提前 7 天开始提醒，判错的代价更大。\n\n## 5. `due_hint` 的语义随 type 变\n\n- `deadline`：**截止时刻**。用户说了几点就填几点；只说了哪天就只填日期；只说了哪个月就只填年月\n- `event`：**发生时刻**。用户说了几点就填几点；只知道哪天就只填日期\n- `daily`：`due_hint` 必须是 `null`，用 `daily_time_hint` 表达每日提醒时刻\n\n形状按精度三选一：`2026-10-30T15:00:00+08:00` / `2026-10-30` / `2026-10`。\n换算基准是 system 消息末尾给出的【当前时间】——"明天""下周三""三小时后"都以它为准。\n用户没给钟点时**不要替他补**，日期就是日期。\n\n## 6. `daily_time_hint` 只给 daily 用\n\n是每天提醒的时刻，形如 `21:00`。用户没说就填 `null`，**不要自己编一个时间**——\n客户端有默认值。非 daily 类型一律填 `null`。\n\n## 7. `requires_evidence`：这件事有没有可验证的产出\n\n| 值 | 例子 |\n|---|---|\n| `true` | 写文档、交报告、做作业、发邮件给对方、完成代码提交、考试成绩出来 |\n| `false` | 跑步、背单词、喝水、冥想、打电话问候、看一集课程 |\n\n判不准时填 `true`——宁可多要一句"做完了"，也不让积分变成空口领奖。\n`daily` 类型默认 `false`（每天传一次截图太折磨），除非这个习惯本身有产出（如"每天写 500 字"）。\n\n## 8. 难度怎么判\n\n- `trivial`：10 分钟以内、单步、无依赖（回一条消息、买个东西）\n- `easy`：10–30 分钟、步骤清楚\n- `medium`：半小时到两小时，或需要 2–3 个步骤\n- `hard`：半天以上，或跨人协作、有明显阻碍\n- `epic`：跨多天、有明显不确定性\n\n难度还受类型限制，**越界视为无效输出**（不是让你改成合法值，而是说明你把类型或难度判错了）：\n\n| type | 只能填 |\n|---|---|\n| `daily` | `trivial` / `easy` / `medium` |\n| `deadline` | `easy` / `medium` / `hard` |\n| `event` | `medium` / `hard` / `epic` |\n\n`estimate_min` 只用于提示与判难度，**不要**因为"这件事要很久"就把难度往上抬一档：\n难度看的是"费不费劲"，不是"占多少时间"。\n\n## 9. 图片\n\n- 图里没有任务信息（纯风景、无字截图、表情包）→ `intent: "chat"`，`tasks: []`，正常回一句话。\n- 图里出现的是**已经做完的事**（打卡记录、已勾选的清单、完成截图）→ `intent: "review_task"`，\n  `tasks: []`，不要重新建一个"要做"的任务。\n- 图里有字有事项 → 照文字抽任务，`detail_md` 里可以引用图上的原文。\n- 看不清的字段不要猜，写进 `missing_info`。\n\n## 10. `intent` 四个取值\n\n- `create_task`：用户要记一件事、或图里有待办。\n- `review_task`：用户说"做完了 / 交了 / 搞定了"，或图里是完成记录。\n- `query`：用户在问已有的数据（"我今天做了多少""这周还有什么事"）。\n- `chat`：闲聊、提问与任务无关的事、上面都不沾。\n\n## 11. `reply` 的写法\n\n- 建了任务：说一句你理解成了什么 + 有没有要用户补的（不超过两句）。\n- `missing_info` 非空：在 `reply` 里点出最要紧的那一条，不要罗列。\n- 纯闲聊：正常回一句，别硬往任务上拐。\n\n# 示例\n\n下面的示例用来对齐**格式**。里面的日期是按"当前时间 = 2026-10-29 星期四"写的，只是格式示例：\n实际换算一律以 system 消息末尾的【当前时间】为准，**不要照抄示例里的日期**。\n';
const memorySystem = '<!-- v1 2026-10-31 -->\n# 任务\n\n从这段对话里挑出**值得长期记住**的信息，输出 JSON。没有就返回空数组——**空数组是常态**。\n\n## 输出形状\n\n严格按这个形状，不多一个键、不少一个键：\n\n```json\n{ "memories": [ { "contentMd": "对方在读研二，方向是分布式系统", "kind": "profile" } ] }\n```\n\n`kind` 三选一：`profile`（我是谁、我的处境与目标）/ `preference`（我喜欢或不喜欢什么、希望怎么被对待）/ `fact`（可核对的事实性信息）。\n\n## 四条否定条件（不写死的话你会每轮都记一句废话）\n\n- 「对方随口说的话」「这次聊的具体内容」「已经存在的记忆」都不记。\n- 只记**跨对话仍然成立**的事实：身份、长期偏好、稳定的人际 / 宠物 / 工作关系、明确说过的目标。\n- 不记情绪（「他今天心情不好」）、不记临时状态（「他现在在写代码」）、不记任务本身（任务是任务表的事）。\n- 一条不超过 30 字，写成陈述句，主语用「对方」。\n\n## 上限\n\n最多 2 条。宁可少记，不要凑数。\n';
const reviewSystem = '<!-- v2 2026-11-05：加第 6 节文字说明 -->\n# 这一轮要判断的事\n\n用户说某件事做完了（或者交了一张图当证据）。你要判断：**这件事到底做完了没有、做到什么程度**，\n并给出一句能站得住的判断依据。\n\n你只看证据，不看态度。用户在聊天里说"我交了"不构成证据；\n但用户在证据区**亲手写下的文字说明**（证据列表里的 `文字证据：…`）算证据的一部分，用法见下面第 6 节。\n\n# 输出形状\n\n严格按这个形状，不多一个键，不少一个键：\n\n```json\n{\n  "verdict": "pass | partial | fail | need_evidence",\n  "quality": "partial | met | exceeded | null",\n  "result": "exceeded | met | below | null",\n  "reason": "一句话判断依据",\n  "followup": "要补什么证据",\n  "gaps": ["还差的部分"]\n}\n```\n\n- `reason`：不超过 50 字，写**依据**（"截图显示报告已导出为 PDF，含完整实验数据"），\n  不写"看起来完成了""应该没问题"这类空话。\n- `followup`：不超过 40 字，只在 `verdict = need_evidence` 时给，其它情况填 `null`。\n- `gaps`：只在 `verdict = partial` 时逐条列（每条不超过 40 字），其它情况填 `[]`。\n\n# 判定标准（按顺序执行）\n\n1. **先看证据，再看用户话术。** 用户说"做完了"不构成证据。\n2. **这次没有任何证据** → 只能 `need_evidence`，`followup` 说明要什么\n   （"发一下报告文件""截个提交记录"）。**不许猜、不许先给结论。**\n3. **证据非空** → 逐个对照证据与任务描述：\n   - 证据能证明核心产出完成 → `pass` + `quality: met`；明显超出要求 → `pass` + `exceeded`\n   - 证据只覆盖部分步骤，或有明显缺口 → `partial` + `partial`，`gaps` 逐条写缺什么\n   - 证据与任务**对不上**（发了个无关截图、只有一句"我做了"）→ `need_evidence`，\n     `followup` 指出对不上在哪\n4. **用户明确说没做 / 没做完** → `fail`。\n5. 判不准时用 `need_evidence`，不要用 `pass` 赌一把：前者只是多问一句，后者是白发一次分。\n\n# 活动类任务：结果不达标就是失败\n\n活动类任务（考试、面试、比赛、评审这类）看的是**结果**，不是"过程有没有做完"。\n任务描述里通常写清了达标条件，例如"60 分及格""进前三""拿到证书""通过面试"。\n\n判定顺序：\n\n1. **先从任务标题与描述里找出达标条件。** 描述写了就必须按描述判；\n   没写才按常识：考试、测验看及格线（多数为 60 分）；比赛、竞赛看有没有名次或奖项；\n   面试看是否通过或录用；其它活动按"有没有达成这件事的基本目的"。\n2. **证据里能不能看到结果本身？** 也就是成绩单、分数截图、证书、名次榜、录取通知、\n   评分截图这类东西。**只看到"我在考场""我在比赛现场"不算结果。**\n   - 看不到结果 → `need_evidence`，`followup` 要具体的东西（"发一下成绩单"）。\n   - 看得到结果 → 进入第 3 步。\n3. **拿这个结果与达标条件比：**\n   - 明显好于条件（高分通过、拿了更好的名次） → `pass` + `result: "exceeded"`\n   - 刚好达到条件 → `pass` + `result: "met"`\n   - **`quality` 一律填 `"met"`**，活动不看完成度。\n4. **结果低于达标条件 → `fail` + `result: "below"`。**\n   这时 `reason` 必须写清差在哪（"总分 48，低于 60 分及格线"），\n   **不要写"不理想""有待提高"这种没有数字的空话**。\n\n注意：活动类任务**不存在"做得认真所以算完成"这条路**。没及格就是没完成，没拿到奖就是没完成。\n\n# 非活动类任务\n\n非活动类任务的 `result` **一律填 `null`**，上面的规则不适用。\n\n# 6. 文字说明怎么用\n\n`文字证据：…` 是用户自己写的一段话。它不是截图、不是文件，用法有三条：\n\n1. **纯文字、没有任何附件证据** → 最高只能 `partial`，`gaps` 写明缺什么。\n   话说得再诚恳也不给 `pass`——一段话不能证明产出存在。\n2. **用来解释某一类证据为什么不存在**：交给老师、纸质提交、线下当面完成、别人代交，\n   这类情况下"提交记录截图"客观上拿不到。如果文字说明与任务描述相符，\n   并且**已有的附件证据能证明产出本身**（作业照片、报告文件），就按产出判 `pass`，\n   不要再因为缺提交记录反复 `need_evidence`。\n3. **文字说明与附件证据互相矛盾**（说明说交了、截图显示没做）→ `need_evidence`，\n   `followup` 指出矛盾在哪。\n\n活动类任务的**结果**不适用第 2 条：分数、名次、证书必须有能看见的东西，\n文字说明不能替代结果证据。\n\n# 不要做的事\n\n- 不要因为"用户很努力"就放行。\n- 不要在 `reason` 里写分数或建议分值。\n- 不要把"需要补证据"写成"失败了"——它们是两件事。\n';
const summarizeSystem = '<!-- v1 2026-10-31 -->\n# 任务\n\n把一段对话压缩成摘要，供下一轮聊天当背景用。**只压缩，不评价，不续写。**\n\n## 输出形状\n\n严格按这个形状，不多一个键、不少一个键：\n\n```json\n{ "summaryMd": "……" }\n```\n\n## 要求\n\n- 不超过 600 字。\n- 一段连续的中文，不分点、不列清单、不加 markdown。\n- 保留：对方说过的身份与处境、明确的目标与偏好、聊到的重要结论、还没回答的问题。\n- 丢掉：寒暄、重复、语气词、你已经记进长期记忆的那些事实（它们会另外拼进 prompt）。\n- 写"发生了什么"，不要写"用户和助手进行了友好的交流"这类空话。\n- 如果给了旧摘要，把它和新的对话合成**一段**，不要分「之前」「之后」两段。\n';
const fxSystem = '<!-- v45 2026-10-31 -->\n你是零花钱汇率的评估器，只输出 JSON。\n\n背景：这个产品里的积分就是零花钱额度，基准是 1 积分 = 1 元。每周一按上周的实际表现，\n把「1 积分值多少元」小幅调整一次，合法区间 0.85 ~ 1.15。\n\n输入是一段 JSON：上周一到周日的日聚合（day / points / tasks_done / occurrences_done），\n以及上周判失败的限时与活动任务数 missed。\n\n判断原则：\n- 完成得多、遗漏少 → 调高（升值，同样的积分能换更多钱）；\n- 完成得少、判失败多、整周几乎没动静 → 调低（贬值）；\n- 数据平平就贴近 1.0，不要为了「看起来有变化」而大幅摆动。\n\n输出格式（**只输出这个 JSON，不要代码围栏、不要解释、不要对用户说话**）：\n{"rate": 1.08, "reason": "上周打卡基本全勤，两个限时按时完成"}\n\nrate 必须是数字，落在 0.85 ~ 1.15 之间，最多两位小数；reason 不超过 60 字。\n';
const systemBase = '<!-- v1 2026-10-29 -->\n# 你的位置\n\n你是 taskloop 的会话助手。用户发来一段话、一张图，或者两者都有。你负责三件事：\n\n1. 判断这一轮用户想干什么（`intent`）；\n2. 如果里面有"要做的事"，把它整理成可以直接执行的任务草稿；\n3. 回一句话给用户。\n\n你不负责算分、不负责判断做没做完的结果、不负责写数据库。**难度档位你判，分值系统自己算。**\n\n# 语言与口气\n\n- 一律简体中文。\n- `reply` 像同事随口回一句：短、直、具体。不要"好的""收到""没问题"开头，不要敬语堆砌，不要"希望对你有帮助"。\n- 不要在 `reply` 里复述字段名、贴 JSON、解释你的判断过程。\n\n# 四条铁律\n\n1. **只输出一个 JSON 对象。** 不要 markdown 围栏，不要在 JSON 前后写任何说明文字。\n2. **不臆造。** 用户没说、图里也没有的时间、地点、人数、金额、对方姓名，一律不要编。缺就是缺。\n3. **不给任何分数。** 不提积分、不提评分、不提等级分。你只判难度档位，分值由系统按难度算。\n4. **不确定就说不确定。** 宁可 `missing_info` 里多写一条、`confidence` 给低一点，也不要用编出来的细节把任务填满。\n';
function bodyOf$1(raw) {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}
const SYSTEM_BASE = systemBase;
const PARSE_SYSTEM = parseSystem;
const REVIEW_SYSTEM = reviewSystem;
const CHAT_RULES = bodyOf$1(chatSystem);
const MEMORY_SYSTEM = bodyOf$1(memorySystem);
const SUMMARIZE_SYSTEM = bodyOf$1(summarizeSystem);
const FX_SYSTEM = bodyOf$1(fxSystem);
const PROMPT_VERSION = "v1 2026-10-29";
const FEWSHOT = fewshot;
function parseFewshotMessages() {
  const messages = [];
  for (const example of FEWSHOT.examples) {
    messages.push({ role: "user", content: example.user });
    messages.push({ role: "assistant", content: JSON.stringify(example.assistant) });
  }
  return messages;
}
function buildParseSystem(now = /* @__PURE__ */ new Date(), timeZone) {
  return `${SYSTEM_BASE}

${PARSE_SYSTEM}

${nowHint(now, timeZone)}`;
}
function buildReviewSystem(now = /* @__PURE__ */ new Date(), timeZone) {
  return `${SYSTEM_BASE}

${REVIEW_SYSTEM}

${nowHint(now, timeZone)}`;
}
const MAX_IMAGES = 4;
const CONTEXT_MESSAGES = 6;
const REMINDER_OFFSETS = {
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440],
  daily: []
};
function toDataUrl(image) {
  return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
}
function contextMessages(recent2) {
  if (!recent2 || recent2.length === 0) return [];
  const picked = recent2.filter((m) => (m.role === "user" || m.role === "assistant") && m.contentMd.trim().length > 0).slice(-CONTEXT_MESSAGES);
  return picked.map((m) => ({ role: m.role, content: m.contentMd }));
}
function buildParseRequest(input) {
  const images = input.images.filter((i) => i.mime.startsWith("image/"));
  const others = input.images.filter((i) => !i.mime.startsWith("image/"));
  const used = images.slice(0, MAX_IMAGES);
  const droppedImages = images.length - used.length;
  const text = input.text.trim();
  const parts = [];
  parts.push({
    type: "text",
    text: text.length > 0 ? text : "（用户没有打字，只发了图）"
  });
  for (const image of used) {
    parts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
  }
  for (const other of others) {
    parts.push({ type: "text", text: `（用户还附了一个文件：${other.mime}）` });
  }
  const messages = [
    { role: "system", content: buildParseSystem(input.now, input.timeZone) },
    ...parseFewshotMessages(),
    ...contextMessages(input.recent),
    { role: "user", content: parts }
  ];
  return { messages, droppedImages, unsupportedAttachments: others.length };
}
function toDueHint(value, type) {
  if (type === "daily" || value === null) return null;
  const precision = duePrecisionOf(value);
  if (precision === "minute") return new Date(value).toISOString();
  if (precision === "day" || precision === "month") return value;
  return null;
}
function withImageNote(reply, droppedImages) {
  if (droppedImages <= 0) return reply;
  return `${reply}${AI_COPY.imagesDropped}`;
}
function toTaskDrafts(result, cfg) {
  return result.tasks.map((task) => ({
    localId: newId(8),
    type: task.type,
    title: task.title,
    detailMd: task.detail_md,
    difficulty: task.difficulty,
    estimateMin: task.estimate_min,
    dueHint: toDueHint(task.due_hint, task.type),
    dailyTimeHint: task.type === "daily" ? task.daily_time_hint : null,
    // 04 §3.2 的"每日可选结束日期"没有模型来源：留给用户在卡面上填
    activeToHint: null,
    reminderOffsets: [...REMINDER_OFFSETS[task.type]],
    tags: task.tags,
    steps: task.steps.map((step) => ({
      localId: newId(8),
      title: step.title,
      estimateMin: step.estimate_min ?? null,
      done: false
    })),
    missingInfo: task.missing_info,
    requiresEvidence: task.requires_evidence,
    confidence: task.confidence,
    // 唯一口径（02 §5.2b）：daily 取 cfg.dailyBase，其余看难度
    pointsPlanned: task.type === "daily" ? cfg.dailyBase : computePlannedPoints(task.type, task.difficulty, cfg)
  }));
}
const TYPE_LABEL$1 = {
  daily: "每日",
  deadline: "限时",
  event: "活动"
};
function hardGateOf(_task, evidenceCount) {
  if (evidenceCount > 0) return null;
  return {
    verdict: "need_evidence",
    quality: null,
    result: null,
    reason: AI_COPY.needEvidenceReason,
    followup: AI_COPY.needEvidenceFollowup,
    gaps: []
  };
}
function taskBrief(task, userText) {
  const lines = [];
  lines.push(`任务标题：${task.title}`);
  lines.push(`任务类型：${TYPE_LABEL$1[task.type]}`);
  if (task.dueAt !== null) {
    lines.push(`${task.type === "event" ? "发生时间" : "截止时间"}：${task.dueAt}`);
  }
  if (task.detailMd.trim().length > 0) lines.push(`任务描述：${task.detailMd.trim()}`);
  if (userText !== void 0 && userText.trim().length > 0) {
    lines.push(`用户这一轮说：${userText.trim()}`);
  }
  return lines.join("\n");
}
function buildReviewRequest(input) {
  const evidenceLines = [];
  const imageParts = [];
  let index = 0;
  for (const item of input.evidence) {
    index += 1;
    if (item.kind === "text") {
      evidenceLines.push(`${index}. 文字证据：${item.text}`);
    } else if (item.kind === "file") {
      evidenceLines.push(`${index}. 附件证据（无法预览内容，只能看到类型）：${item.mime}`);
    } else {
      evidenceLines.push(`${index}. 图片证据（见下）`);
      imageParts.push({ type: "image_url", image_url: { url: toDataUrl(item) } });
    }
  }
  const header = {
    type: "text",
    text: `${taskBrief(input.task, input.userText)}

证据共 ${input.evidence.length} 条：
` + (evidenceLines.length > 0 ? evidenceLines.join("\n") : "（无）")
  };
  return [
    { role: "system", content: buildReviewSystem(input.now, input.timeZone) },
    { role: "user", content: [header, ...imageParts] }
  ];
}
function toVerdict(raw, type) {
  const verdict = type === "event" && raw.result === "below" ? "fail" : raw.verdict;
  const scored = verdict === "pass" || verdict === "partial";
  const quality = scored ? type === "event" ? "met" : raw.quality ?? "met" : null;
  return {
    verdict,
    quality,
    result: type === "event" ? raw.result ?? null : null,
    reason: raw.reason,
    followup: raw.followup ?? null,
    // 04 §3.3：只有 partial 会在卡面逐条列缺口，其他 verdict 一律空数组
    gaps: verdict === "partial" ? raw.gaps ?? [] : []
  };
}
const CHAT_STATE_ID = "main";
const SELECT = "SELECT id, summary_md, upto_message_id, updated_at FROM chat_state";
function mapState(row2) {
  return {
    id: row2.id,
    summaryMd: row2.summary_md,
    uptoMessageId: row2.upto_message_id,
    updatedAt: row2.updated_at
  };
}
function get() {
  const row2 = getDb().prepare(`${SELECT} WHERE id = ?`).get(CHAT_STATE_ID);
  if (row2) return mapState(row2);
  const now = nowIso();
  try {
    getDb().prepare("INSERT INTO chat_state (id, summary_md, upto_message_id, updated_at) VALUES (?, ?, ?, ?)").run(CHAT_STATE_ID, "", null, now);
  } catch (e) {
    throw wrapWriteError(e, "会话摘要写入失败");
  }
  return { id: CHAT_STATE_ID, summaryMd: "", uptoMessageId: null, updatedAt: now };
}
function setSummary(patch2) {
  get();
  try {
    getDb().prepare("UPDATE chat_state SET summary_md = ?, upto_message_id = ?, updated_at = ? WHERE id = ?").run(patch2.summaryMd, patch2.uptoMessageId, nowIso(), CHAT_STATE_ID);
  } catch (e) {
    throw wrapWriteError(e, "会话摘要写入失败");
  }
  return get();
}
const MONTHLY_BUDGET_CENTS = 5e4;
const MAX_SPEND_CENTS = 1e5;
const RATE_MIN = 0.85;
const RATE_MAX = 1.15;
const SELECT_FX = `SELECT ${FX_RATE_COLUMNS.join(", ")} FROM fx_rates`;
function latest() {
  const row2 = getDb().prepare(`${SELECT_FX} ORDER BY week_start DESC LIMIT 1`).get();
  return row2 === void 0 ? null : mapFxRate(row2);
}
function byWeek(weekStart) {
  const row2 = getDb().prepare(`${SELECT_FX} WHERE week_start = ?`).get(weekStart);
  return row2 === void 0 ? null : mapFxRate(row2);
}
function insert$2(row2) {
  getDb().prepare(
    `INSERT INTO fx_rates (${FX_RATE_COLUMNS.join(", ")})
       VALUES (${FX_RATE_COLUMNS.map(() => "?").join(", ")})`
  ).run(...fxRateInsertParams(row2));
}
function weekSnapshot(from, to) {
  const days = getDb().prepare(
    `SELECT ${DAY_STAT_COLUMNS.join(", ")} FROM daily_stats
         WHERE day >= ? AND day <= ? ORDER BY day ASC`
  ).all(from, to).map(mapDayStat);
  const missed = getDb().prepare(
    `SELECT COUNT(*) AS n FROM tasks
       WHERE status = 'missed' AND date(updated_at, 'localtime') >= ? AND date(updated_at, 'localtime') <= ?`
  ).get(from, to);
  return { days, missedTasks: missed.n };
}
const fxSchema = zod.z.object({
  rate: zod.z.number(),
  reason: zod.z.string().max(200)
});
function buildFxPayload(input) {
  const days = input.days.map((day) => ({
    day: day.day,
    points: day.points,
    tasks_done: day.tasksDone,
    occurrences_done: day.occurrencesDone
  }));
  return JSON.stringify({ week_start: input.weekStart, days, missed: input.missedTasks });
}
function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
async function evaluateFx(input) {
  const { data } = await input.provider.chatJson({
    messages: [
      { role: "system", content: FX_SYSTEM },
      { role: "user", content: buildFxPayload(input) }
    ],
    schema: fxSchema,
    temperature: 0
  });
  if (!Number.isFinite(data.rate) || data.rate <= 0) {
    throw appError("AI_PARSE_FAILED", "汇率评估结果不可用", {
      detail: `rate=${String(data.rate)}`
    });
  }
  const rate = roundPoints(clamp(data.rate, RATE_MIN, RATE_MAX));
  return { rate, reason: data.reason };
}
const BASE_RATE = 1;
function weekStartOf(day) {
  return addDays(day, -(isoWeekday$1(day) - 1));
}
function currentRate() {
  const thisWeek = weekStartOf(toLocalDay(/* @__PURE__ */ new Date()));
  const weekly = byWeek(thisWeek);
  if (weekly !== null) return { rate: weekly.rate, weekStart: weekly.weekStart };
  const recent2 = latest();
  if (recent2 !== null) return { rate: recent2.rate, weekStart: recent2.weekStart };
  return { rate: BASE_RATE, weekStart: thisWeek };
}
async function ensureWeek(now = /* @__PURE__ */ new Date()) {
  const weekStart = weekStartOf(toLocalDay(now));
  const existing = byWeek(weekStart);
  if (existing !== null) return existing;
  const previous = latest();
  const carry = previous === null ? BASE_RATE : previous.rate;
  const lastFrom = addDays(weekStart, -7);
  const lastTo = addDays(weekStart, -1);
  const snapshot = weekSnapshot(lastFrom, lastTo);
  const activity = snapshot.days.reduce((sum, day) => sum + day.tasksDone + day.occurrencesDone, 0) + snapshot.missedTasks;
  const ai = await Promise.resolve().then(() => aiService);
  let rate = carry;
  let source = "fallback";
  let basis = "";
  if (ai.keyStatus().configured && activity > 0) {
    try {
      const evaluated = await evaluateFx({
        provider: ai.backgroundProvider(),
        weekStart: lastFrom,
        days: snapshot.days,
        missedTasks: snapshot.missedTasks
      });
      rate = evaluated.rate;
      source = "ai";
      basis = evaluated.reason;
      console.info(`[fx] 本期汇率 ${rate}`, basis);
    } catch (e) {
      console.warn("[fx] 评估失败，沿用上期汇率", e);
    }
  }
  const createdAt = nowIso();
  try {
    insert$2({ id: newId(), weekStart, rate, basis, source, createdAt });
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const raced = byWeek(weekStart);
    if (raced !== null) return raced;
    throw e;
  }
  broadcast({ type: "fx.changed", rate, weekStart });
  return { weekStart, rate, source, createdAt };
}
const STREAK_SCAN_LIMIT = 3660;
function balance() {
  return balance$1();
}
function listLedger(options = {}) {
  return list$4(options);
}
function recentLedger(limit = 20) {
  return recent(limit);
}
function monthStats(year, month) {
  return monthStats$1(year, month);
}
function todayStat() {
  return getDay(todayLocalDay());
}
function dayStatOf(day) {
  return getDay(day);
}
function pointsConfig() {
  return {
    difficultyBase: get$2("points.difficultyBase"),
    deadlineBase: get$2("points.deadlineBase"),
    dailyBase: get$2("points.dailyBase"),
    streakBonus: get$2("points.streakBonus"),
    dailyCap: get$2("points.dailyCap")
  };
}
function previewPoints(type, difficulty) {
  const cfg = pointsConfig();
  if (type === "daily") return roundPoints(cfg.dailyBase);
  return computePlannedPoints(type, difficulty, cfg);
}
function streakBonusAt(streakAfter) {
  return computeDailyPoints(streakAfter, pointsConfig()).bonus;
}
function award(input) {
  const day = input.day ?? todayLocalDay();
  const delta = roundPoints(input.delta);
  return tx(() => {
    const entry = insert$5({
      id: input.id ?? newId(),
      taskId: input.taskId ?? null,
      occurrenceId: input.occurrenceId ?? null,
      delta,
      kind: input.kind ?? (delta < 0 ? "penalty" : "award"),
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? "",
      day,
      createdAt: nowIso()
    });
    addPoints(day, delta);
    return entry;
  });
}
function adjust(delta, reasonText) {
  const rounded = roundPoints(delta);
  if (rounded === 0) throw appError("INVALID_INPUT", "调整分不能为 0");
  return award({
    taskId: null,
    occurrenceId: null,
    delta: rounded,
    kind: "adjust",
    reasonCode: "manual_adjust",
    reasonText
  });
}
function rollback(entry, reasonText) {
  markReversed(entry.id, nowIso());
  return award({
    taskId: entry.taskId,
    occurrenceId: null,
    delta: -entry.delta,
    kind: "adjust",
    reasonCode: "manual_adjust",
    reasonText: reasonText || `撤销 ${entry.id}`,
    day: todayLocalDay()
  });
}
function spend(input) {
  const amountCents = input.amountCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw appError("INVALID_INPUT", "金额必须是正数", {
      detail: `amountCents=${String(amountCents)}`
    });
  }
  if (amountCents > MAX_SPEND_CENTS) {
    throw appError("INVALID_INPUT", "单笔支出不能超过 1000 元", {
      detail: `amountCents=${amountCents} > ${MAX_SPEND_CENTS}`
    });
  }
  const { rate } = currentRate();
  const delta = -roundPoints(amountCents / 100 / rate);
  if (delta === 0) {
    throw appError("INVALID_INPUT", "金额太小，扣不进积分", {
      detail: `amountCents=${amountCents} rate=${rate}`
    });
  }
  const day = todayLocalDay();
  return tx(() => {
    const entry = insert$5({
      id: newId(),
      taskId: null,
      occurrenceId: null,
      delta,
      kind: "spend",
      reasonCode: "pocket_spend",
      reasonText: input.note ?? "",
      day,
      createdAt: nowIso(),
      amountCents,
      fxRate: rate
    });
    addPoints(day, delta);
    return entry;
  });
}
function spendMonth() {
  const day = todayLocalDay();
  const [year, month] = day.split("-").map(Number);
  const { from, to } = monthBounds(year, month);
  const { rate, weekStart } = currentRate();
  return {
    entries: listSpend(from, to),
    totalCents: sumSpendCents(from, to),
    rate,
    weekStart
  };
}
function spendUndo(entryId) {
  return tx(() => {
    const entry = byId(entryId);
    if (entry === null || entry.kind !== "spend") {
      throw appError("NOT_FOUND", "找不到这笔支出", { detail: `id=${entryId}` });
    }
    if (entry.reversedAt !== null) {
      throw appError("CONFLICT", "这笔支出已经撤销过了", { detail: `id=${entryId}` });
    }
    return rollback(entry, "撤销支出");
  });
}
function isScheduledDay(task, day) {
  if (task.activeFrom !== null && day < task.activeFrom) return false;
  if (task.activeTo !== null && day > task.activeTo) return false;
  const anchor2 = task.activeFrom ?? toLocalDay(new Date(task.createdAt));
  return matchesRepeatDay(task.repeatRule, day, anchor2);
}
function streakFromHistory(task, history, endingDay) {
  let streak = 0;
  for (let i = 0; i < STREAK_SCAN_LIMIT; i += 1) {
    const day = addDays(endingDay, -i);
    if (task.activeFrom !== null && day < task.activeFrom) break;
    const status = history.get(day);
    if (status === void 0) {
      if (isScheduledDay(task, day)) break;
      continue;
    }
    if (status !== "done") break;
    streak += 1;
  }
  return streak;
}
function streakEndingAt(task, endingDay) {
  const history = new Map(listByTask$2(task.id).map((o) => [o.day, o.status]));
  return streakFromHistory(task, history, endingDay);
}
function awardOccurrence(occurrenceId) {
  const cfg = pointsConfig();
  return tx(() => {
    const occ = requireById$5(occurrenceId);
    const taskBefore = requireById$6(occ.taskId);
    if (taskBefore.status === "discarded" || taskBefore.status === "archived") {
      throw appError("CONFLICT", "任务已删除", {
        detail: `task=${taskBefore.id} status=${taskBefore.status}`
      });
    }
    const history = new Map(listByTask$2(taskBefore.id).map((o) => [o.day, o.status]));
    history.set(occ.day, "done");
    const streakAfter = streakFromHistory(taskBefore, history, occ.day);
    const { base, bonus } = computeDailyPoints(streakAfter, cfg);
    const day = occ.day;
    const entry = award({
      taskId: taskBefore.id,
      occurrenceId: occ.id,
      delta: base,
      kind: "award",
      reasonCode: "task_done",
      reasonText: taskBefore.title,
      day
    });
    if (bonus > 0) {
      award({
        taskId: taskBefore.id,
        occurrenceId: null,
        delta: bonus,
        kind: "award",
        reasonCode: "streak_bonus",
        reasonText: taskBefore.title,
        day
      });
    }
    const occurrence = complete({
      occurrence: occ,
      pointsAwarded: roundPoints(base + bonus),
      completedAt: nowIso(),
      streakAfter
    });
    return {
      occurrence,
      entry,
      streakAfter,
      taskBefore,
      task: requireById$6(taskBefore.id)
    };
  });
}
function entriesOfOccurrence(occ) {
  if (occ.status !== "done") return [];
  return list$4({ from: occ.day, to: occ.day }).filter(
    (e) => (
      // 已冲销的行不能再冲一次：撤销→重做→再撤销时，同一天会同时存在
      // "被冲过的旧行"和"新的有效行"，不过滤就会把余额扣两次（v0.19）
      e.reversedAt === null && (e.occurrenceId === occ.id || e.occurrenceId === null && e.taskId === occ.taskId && e.reasonCode === "streak_bonus")
    )
  );
}
function undoOccurrence(occurrenceId) {
  return tx(() => {
    const occ = requireById$5(occurrenceId);
    const taskBefore = requireById$6(occ.taskId);
    for (const e of entriesOfOccurrence(occ)) rollback(e, taskBefore.title);
    const streakAfter = streakEndingAt(taskBefore, addDays(occ.day, -1));
    const occurrence = undo({ occurrence: occ, streakAfter });
    return {
      occurrence,
      balanceAfter: balance$1(),
      taskBefore,
      task: requireById$6(taskBefore.id)
    };
  });
}
function skipOccurrence(occurrenceId, note2) {
  return tx(() => {
    const occ = requireById$5(occurrenceId);
    if (occ.status === "done") return occ;
    return skip({ occurrence: occ, note: note2 });
  });
}
const DIFFICULTY_ORDER = [
  "trivial",
  "easy",
  "medium",
  "hard",
  "epic"
];
const ALLOWED_DIFFICULTIES = {
  daily: ["trivial", "easy", "medium"],
  deadline: ["easy", "medium", "hard"],
  event: ["medium", "hard", "epic"]
};
function isDifficultyAllowed(type, difficulty) {
  return ALLOWED_DIFFICULTIES[type].includes(difficulty);
}
const TYPE_LABEL = {
  daily: "每日",
  deadline: "限时",
  event: "活动"
};
function snapDifficulty(type, difficulty) {
  const allowed = ALLOWED_DIFFICULTIES[type];
  if (allowed.includes(difficulty)) return difficulty;
  const target = DIFFICULTY_ORDER.indexOf(difficulty);
  let best = allowed[0];
  let bestDist = Math.abs(DIFFICULTY_ORDER.indexOf(best) - target);
  for (const candidate of allowed) {
    const dist = Math.abs(DIFFICULTY_ORDER.indexOf(candidate) - target);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}
const DEFAULT_OFFSETS = {
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440],
  daily: []
};
function assertTitle(title) {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw appError("INVALID_INPUT", "任务标题不能为空");
  if (trimmed.length > 40) {
    throw appError("INVALID_INPUT", "任务标题最多 40 个字", { detail: `实际 ${trimmed.length} 字` });
  }
  return trimmed;
}
function assertRepeatRule(rule) {
  if (rule === null) return;
  try {
    parseRepeatRule(rule);
  } catch {
    throw appError("INVALID_INPUT", "重复规则格式不正确", { detail: rule });
  }
}
function createTask(input) {
  const title = assertTitle(input.title);
  const now = nowIso();
  const id = input.id ?? newId();
  assertRepeatRule(input.repeatRule ?? null);
  const isDaily = input.type === "daily";
  const offsets = isDaily ? [] : input.reminderOffsets ?? DEFAULT_OFFSETS[input.type] ?? [];
  const difficulty = input.difficulty ?? "medium";
  if (!isDifficultyAllowed(input.type, difficulty)) {
    throw appError("INVALID_INPUT", "该任务类型不支持所选难度", {
      detail: `${input.type} + ${difficulty}`
    });
  }
  if (input.pointsPlanned !== void 0 && !(input.pointsPlanned >= 1)) {
    throw appError("INVALID_INPUT", "应得分必须 ≥ 1", { detail: `收到 ${input.pointsPlanned}` });
  }
  return tx(() => {
    const cfg = pointsConfig();
    const pointsPlanned = isDaily ? cfg.dailyBase : input.pointsPlanned ?? computePlannedPoints(input.type, difficulty, cfg);
    const task = insert$7({
      id,
      type: input.type,
      status: input.status ?? "todo",
      title,
      detailMd: input.detailMd ?? "",
      parentId: input.parentId ?? null,
      sortKey: input.sortKey ?? nextSortKey(input.parentId ?? null),
      priority: input.priority ?? 0,
      difficulty,
      estimateMin: input.estimateMin ?? null,
      dueAt: isDaily ? null : input.dueAt ?? null,
      dailyTime: input.dailyTime ?? null,
      repeatRule: input.repeatRule ?? null,
      activeFrom: input.activeFrom ?? null,
      activeTo: input.activeTo ?? null,
      reminderOffsets: offsets,
      reminderChannels: input.reminderChannels ?? ["inapp"],
      tags: input.tags ?? [],
      pointsPlanned,
      requiresEvidence: input.requiresEvidence ?? false,
      evidence: input.evidence ?? [],
      source: input.source ?? "chat",
      aiConfidence: input.aiConfidence ?? null,
      aiProposal: input.aiProposal,
      createdAt: now,
      updatedAt: now
    });
    bumpTasksCreated(isoToLocalDay(now));
    return task;
  });
}
function createManualTask(input) {
  const task = createTask(input);
  if (input.type !== "daily") return { task, createdOccurrences: [] };
  const today = todayLocalDay();
  ensureRange(today, today);
  const createdOccurrences = listByTask$2(task.id).filter((o) => o.day === today);
  return { task, createdOccurrences };
}
function getTask(id) {
  return getById$5(id);
}
function requireTask(id) {
  return requireById$6(id);
}
function getTaskWithSubtasks(id) {
  const task = requireById$6(id);
  return { ...task, subtasks: listSubtasks(id) };
}
function listTasks(input = {}) {
  return list$5(input);
}
function updateTask(id, patch2) {
  if (patch2.title !== void 0) assertTitle(patch2.title);
  if (patch2.repeatRule !== void 0) assertRepeatRule(patch2.repeatRule);
  const now = nowIso();
  return tx(() => {
    const current2 = requireById$6(id);
    if (patch2.difficulty === void 0) return update$5(id, patch2, now);
    const difficulty = patch2.difficulty;
    if (!isDifficultyAllowed(current2.type, difficulty)) {
      throw appError("INVALID_INPUT", "该任务类型不支持所选难度", {
        detail: `${current2.type} + ${difficulty}`
      });
    }
    const cfg = pointsConfig();
    const pointsPlanned = current2.type === "daily" ? cfg.dailyBase : computePlannedPoints(current2.type, difficulty, cfg);
    update$5(id, patch2, now);
    return updateColumns(id, { points_planned: pointsPlanned }, now);
  });
}
function setRequiresEvidence(id, value) {
  return setRequiresEvidence$1(id, value, nowIso());
}
function addEvidence(id, evidence) {
  if (evidence.kind === "text" && !evidence.text?.trim()) {
    throw appError("INVALID_INPUT", "文字证据不能为空");
  }
  if (evidence.kind === "attachment" && !evidence.attachmentId) {
    throw appError("INVALID_INPUT", "附件证据缺少附件 id");
  }
  return appendEvidence(id, evidence, nowIso());
}
function removeEvidence(id, index) {
  return removeEvidenceAt(id, index, nowIso());
}
function setReminderOffsets(id, offsets, channels) {
  const patch2 = { reminderOffsets: offsets };
  if (channels) patch2.reminderChannels = channels;
  return update$5(id, patch2, nowIso());
}
function transitionTask(id, to) {
  if (to === "done") {
    throw appError("CONFLICT", "完成任务请走完成流程", { detail: "use task.complete" });
  }
  return tx(() => {
    const task = requireById$6(id);
    if (task.status === to) return task;
    assertTransition(task.type, task.status, to);
    const now = nowIso();
    const cols = { status: to };
    if (to === "doing" && task.startedAt === null) cols.started_at = now;
    if (to === "archived") cols.archived_at = now;
    return updateColumns(id, cols, now);
  });
}
function removeTask(id) {
  return tx(() => {
    const now = nowIso();
    requireById$6(id);
    softRemove(id, now);
    removeUnfinishedFrom(id, todayLocalDay());
    removePendingByTask(id);
  });
}
function reorderTask(id, beforeId) {
  reorder(id, beforeId, nowIso());
}
function promoteMarkerOf(draft) {
  return draft;
}
function toDueAt(value) {
  if (value === null || value === void 0 || value === "") return null;
  const precision = duePrecisionOf(value);
  if (precision === "minute") return new Date(value).toISOString();
  if (precision === "day" || precision === "month") return value;
  return null;
}
function toDailyTime(value) {
  if (value === null || value === void 0) return null;
  return /^\d{2}:\d{2}$/.test(value) ? value : null;
}
function toActiveDay(value) {
  if (value === null || value === void 0 || value === "") return null;
  return isValidDay(value) ? value : null;
}
function subtaskTypeOf(type) {
  return type === "daily" ? "deadline" : type;
}
function promoteDraft(input) {
  return tx(() => {
    const message = requireById$4(input.messageId);
    if (message.meta.kind !== "task_draft") {
      throw appError("INVALID_INPUT", "请求参数格式不正确", {
        detail: `消息 ${input.messageId} 的 meta.kind=${message.meta.kind}，不是 task_draft`
      });
    }
    const drafts = message.meta.drafts;
    const index = drafts.findIndex((d) => d.localId === input.localId);
    if (index === -1) {
      throw appError("INVALID_INPUT", "请求参数格式不正确", {
        detail: `消息 ${input.messageId} 里没有 localId=${input.localId} 的草稿`
      });
    }
    const draft = drafts[index];
    const marker = promoteMarkerOf(draft);
    if (marker.promoted === true && typeof marker.promotedTaskId === "string") {
      return { task: requireById$6(marker.promotedTaskId), created: false };
    }
    const patch$1 = input.patch ?? {};
    const cfg = pointsConfig();
    const type = patch$1.type ?? draft.type;
    const isDaily = type === "daily";
    const typeChanged = patch$1.type !== void 0 && patch$1.type !== draft.type;
    const today = todayLocalDay();
    if (patch$1.difficulty !== void 0 && !isDifficultyAllowed(type, patch$1.difficulty)) {
      throw appError("INVALID_INPUT", "该任务类型不支持所选难度", {
        detail: `${type} + ${patch$1.difficulty}`
      });
    }
    const difficulty = patch$1.difficulty ?? draft.difficulty;
    const pointsPlanned = isDaily ? cfg.dailyBase : patch$1.difficulty !== void 0 || typeChanged ? computePlannedPoints(type, difficulty, cfg) : draft.pointsPlanned;
    if (isDaily) assertRepeatRule(patch$1.repeatRule ?? null);
    const task = createTask({
      type,
      title: patch$1.title ?? draft.title,
      detailMd: patch$1.detailMd ?? draft.detailMd,
      difficulty,
      estimateMin: patch$1.estimateMin ?? draft.estimateMin,
      // deadline/event 写 due_at；daily 不使用（01 §2.1.1）——按落库类型映射
      dueAt: isDaily ? null : toDueAt(patch$1.dueAt !== void 0 ? patch$1.dueAt : draft.dueHint),
      dailyTime: isDaily ? toDailyTime(patch$1.dailyTime !== void 0 ? patch$1.dailyTime : draft.dailyTimeHint) : null,
      repeatRule: isDaily ? patch$1.repeatRule ?? null : null,
      activeFrom: isDaily ? patch$1.activeFrom ?? today : null,
      activeTo: isDaily ? toActiveDay(patch$1.activeTo !== void 0 ? patch$1.activeTo : draft.activeToHint) : null,
      reminderOffsets: patch$1.reminderOffsets ?? draft.reminderOffsets,
      tags: patch$1.tags ?? draft.tags,
      pointsPlanned,
      requiresEvidence: patch$1.requiresEvidence ?? draft.requiresEvidence,
      source: "chat",
      aiConfidence: draft.confidence,
      status: "todo"
    });
    for (const step of draft.steps) {
      createTask({
        type: subtaskTypeOf(type),
        title: step.title,
        parentId: task.id,
        ...isDaily ? {} : { difficulty },
        estimateMin: step.estimateMin,
        status: "todo"
      });
    }
    if (isDaily) {
      ensureRange(today, addDays(today, 3));
    }
    const marked = drafts.map(
      (d, i) => i === index ? { ...d, promoted: true, promotedTaskId: task.id } : d
    );
    patch(input.messageId, {
      meta: { kind: "task_draft", drafts: marked },
      linkedTaskId: task.id
    });
    return { task, created: true };
  });
}
function assertCompletable(task) {
  if (task.status === "done") {
    throw appError("CONFLICT", "任务不能从「已完成」直接变为「已完成」", {
      detail: `id=${task.id} 已处于 done`
    });
  }
  assertTransition(task.type, task.status, "done");
}
function leadHoursOf(task, completedAt) {
  if (task.type !== "deadline" || task.dueAt === null) return null;
  const due = dueInstant(task.dueAt);
  if (due === null) return null;
  return (due.getTime() - new Date(completedAt).getTime()) / 36e5;
}
function overdueDaysOf(task, leadHours) {
  if (task.type !== "deadline" || leadHours === null || leadHours >= 0) return 0;
  return Math.floor(Math.abs(leadHours) / 24);
}
function completeTask(input) {
  return input.noPoints === true ? completeWithoutPoints(input.id, input.evidence) : completeWithPoints(input.id, input.quality, input.evidence, input.result);
}
function completeWithPoints(id, quality, evidence, result) {
  const completedAt = nowIso();
  return tx(() => {
    const task = requireById$6(id);
    assertCompletable(task);
    if (task.type === "event" && result === "below") {
      throw appError("CONFLICT", "活动结果不达标不能完成，应判失败", {
        detail: "type=event, result=below"
      });
    }
    const provided = evidence ?? [];
    if (task.evidence.length === 0 && provided.length === 0) {
      throw appError("EVIDENCE_REQUIRED", "证据不能为空", {
        detail: "任务与入参都没有证据"
      });
    }
    for (const item of provided) addEvidence(id, item);
    const leadHours = leadHoursOf(task, completedAt);
    const awarded = computeAwardedPoints({
      type: task.type,
      planned: task.pointsPlanned,
      quality,
      overdueDays: overdueDaysOf(task, leadHours),
      leadHours,
      // `result` 只对 event 生效（02 §5）；deadline / daily 传了忽略，不报错、也不落库
      result: task.type === "event" ? result ?? null : null
    });
    const day = isoToLocalDay(completedAt);
    const updated = updateColumns(
      id,
      { status: "done", completed_at: completedAt, points_awarded: awarded, quality },
      completedAt
    );
    const entry = award({
      taskId: id,
      occurrenceId: null,
      delta: awarded,
      kind: "award",
      reasonCode: "task_done",
      reasonText: task.title,
      day
    });
    bumpTasksDone(day);
    return { task: updated, entry };
  });
}
function completeWithoutPoints(id, evidence) {
  const completedAt = nowIso();
  return tx(() => {
    const task = requireById$6(id);
    assertCompletable(task);
    for (const item of evidence ?? []) addEvidence(id, item);
    const updated = updateColumns(
      id,
      { status: "done", completed_at: completedAt, points_awarded: null, quality: null },
      completedAt
    );
    bumpTasksDone(isoToLocalDay(completedAt));
    return { task: updated, entry: null };
  });
}
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1e3;
function completionAgeMs(task) {
  if (task.completedAt === null) return null;
  const at = new Date(task.completedAt).getTime();
  if (Number.isNaN(at)) return null;
  return Date.now() - at;
}
function undoCompletion(id) {
  return tx(() => {
    const task = requireById$6(id);
    if (task.status !== "done") return { task, entry: null };
    const age = completionAgeMs(task);
    if (age !== null && age > UNDO_WINDOW_MS) {
      throw appError("CONFLICT", "超过 24 小时的完成记录不能撤销", {
        detail: `id=${id} completed_at=${task.completedAt} 距今 ${Math.round(age / 36e5)}h`
      });
    }
    const original = listByTask$1(id).find(
      (e) => e.reasonCode === "task_done" && e.occurrenceId === null && e.reversedAt === null
    ) ?? null;
    const entry = original === null ? null : rollback(original, task.title);
    const day = task.completedAt === null ? todayLocalDay() : isoToLocalDay(task.completedAt);
    const updated = updateColumns(
      id,
      { status: "doing", completed_at: null, points_awarded: null, quality: null },
      nowIso()
    );
    bumpTasksDone(day, -1);
    return { task: updated, entry };
  });
}
function fmtPoints(v) {
  return String(roundPoints(v));
}
function fmtMoney(cents) {
  const total = cents < 0 ? -Math.trunc(cents) : Math.trunc(cents);
  const yuan = (total - total % 100) / 100;
  const fen = total % 100;
  if (fen === 0) return String(yuan);
  if (fen % 10 === 0) return `${yuan}.${fen / 10}`;
  return `${yuan}.${String(fen).padStart(2, "0")}`;
}
function fmtRemaining(dueAt, type, now) {
  if (type !== "deadline" && type !== "event") return "";
  if (!dueAt) return "";
  const due = dueInstant(dueAt);
  if (due === null) return "";
  const diffHours = (due.getTime() - now.getTime()) / 36e5;
  if (diffHours < 0) return "逾期";
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = type === "deadline" && toLocalDay(due) === toLocalDay(tomorrow);
  if (dueHasTime(dueAt)) {
    if (diffHours < 24) return `${Math.max(1, Math.floor(diffHours))}h`;
    if (isTomorrow) return "明天";
    return `${Math.floor(diffHours / 24)}d`;
  }
  if (isTomorrow) return "明天";
  return `${Math.max(1, Math.ceil(diffHours / 24))}d`;
}
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
function fmtDueLabel(dueAt) {
  const precision = duePrecisionOf(dueAt);
  if (precision === null) return "";
  const at = dueInstant(dueAt);
  if (at === null) return "";
  if (precision === "month") return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}`;
  const head = `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return precision === "minute" ? `${head} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : head;
}
function toDatetimeLocal(dueAt) {
  const at = dueInstant(dueAt);
  if (at === null) return "";
  const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return `${day}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}
const BRIEF_MAX_ITEMS = 5;
const BRIEF_TITLE_MAX = 12;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function truncateTitle(title) {
  const chars = Array.from(title);
  if (chars.length <= BRIEF_TITLE_MAX) return title;
  return `${chars.slice(0, BRIEF_TITLE_MAX).join("")}…`;
}
function weekdayOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function dueLabel(dueAt, today, timeZone) {
  const precision = duePrecisionOf(dueAt);
  if (precision === "month") return `${Number(dueAt.slice(5, 7))}月`;
  if (precision === "day") {
    const day2 = dueAt.slice(0, 10);
    return day2 === today ? "今天" : day2.slice(5);
  }
  const day = isoToLocalDay(dueAt, timeZone);
  const time = isoToLocalTime(dueAt, timeZone);
  return day === today ? `今天 ${time}` : `${day.slice(5)} ${time}`;
}
function itemLabel(task, today, timeZone) {
  const title = truncateTitle(task.title);
  if (task.type === "daily") return `${title} · 每日`;
  if (task.dueAt === null) return title;
  const suffix = task.type === "deadline" ? " 截止" : "";
  return `${title} · ${dueLabel(task.dueAt, today, timeZone)}${suffix}`;
}
function yesterdayLineOf(stat) {
  if (stat === void 0) return null;
  const done = stat.tasksDone + stat.occurrencesDone;
  if (done === 0 && stat.points === 0) return "昨天没有记录。";
  return `昨天：完成 ${done} 条，得 ${fmtPoints(stat.points)} 分。`;
}
function buildTodayBrief(input) {
  const now = input.now ?? /* @__PURE__ */ new Date();
  const timeZone = input.timeZone;
  const today = todayLocalDay(timeZone);
  const pending2 = input.tasks;
  const doneToday = input.stat.tasksDone + input.stat.occurrencesDone;
  const overdue = pending2.filter((task) => {
    const due = dueInstant(task.dueAt);
    return due !== null && due.getTime() < now.getTime();
  }).length;
  const head = `今天是 ${today}（${weekdayOf(today)}）${isoToLocalTime(now.toISOString(), timeZone)}。`;
  let body;
  if (pending2.length === 0 && doneToday === 0) {
    body = "今天没有任何任务。";
  } else if (pending2.length === 0) {
    body = `今天没有待办任务，已完成 ${doneToday} 条，逾期 ${overdue} 条。`;
  } else {
    const shown = pending2.slice(0, BRIEF_MAX_ITEMS).map((task) => itemLabel(task, today, timeZone)).join("；");
    const more = pending2.length > BRIEF_MAX_ITEMS ? ` 等 ${pending2.length} 条` : "";
    body = `今天的任务：待办 ${pending2.length} 条（${shown}${more}），已完成 ${doneToday} 条，逾期 ${overdue} 条。`;
  }
  const points = `今天已得 ${fmtPoints(input.stat.points)} 分，总积分 ${fmtPoints(input.balance)} 分。`;
  return [head, body, points, yesterdayLineOf(input.yesterday)].filter((line) => line !== null).join("\n");
}
const MEMORY_MAX_ITEMS = 2;
const MEMORY_EXTRACT_TIMEOUT_MS = 15e3;
const memoryResultSchema = zod.z.object({
  memories: zod.z.array(
    zod.z.object({
      contentMd: zod.z.string(),
      kind: zod.z.enum(["profile", "preference", "fact"])
    })
  ).default([])
});
function buildPrompt(input, existing) {
  const known = existing.length === 0 ? "（还没有任何记忆）" : ["已有记忆（不要重复提取）：", ...existing.map((text) => `- ${text}`)].join("\n");
  return [
    known,
    `本轮用户说：${input.userText}`,
    `本轮你回复：${input.assistantText}`
  ].join("\n\n");
}
async function runMemoryExtract(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMORY_EXTRACT_TIMEOUT_MS);
  try {
    const existing = list$2().map((item) => item.contentMd);
    const { data } = await input.provider.chatJson({
      messages: [
        { role: "system", content: MEMORY_SYSTEM },
        { role: "user", content: buildPrompt(input, existing) }
      ],
      schema: memoryResultSchema,
      temperature: 0,
      signal: controller.signal
    });
    for (const item of data.memories.slice(0, MEMORY_MAX_ITEMS)) {
      addAuto({ contentMd: item.contentMd, kind: item.kind });
    }
  } catch (e) {
    console.warn("[ai] 记忆提取失败，本轮跳过", e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(timer);
  }
}
const SUMMARY_TRIGGER = 40;
const SUMMARY_BATCH = 20;
const SUMMARY_MAX_CHARS = 600;
const SUMMARY_TIMEOUT_MS = 3e4;
const summarySchema = zod.z.object({ summaryMd: zod.z.string() });
function charCount(text) {
  return Array.from(text).length;
}
function clip(text) {
  return charCount(text) <= SUMMARY_MAX_CHARS ? text : `${Array.from(text).slice(0, SUMMARY_MAX_CHARS - 1).join("")}…`;
}
function shouldSummarize(pendingCount) {
  return pendingCount > SUMMARY_TRIGGER;
}
async function maybeSummarize(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const state2 = get();
    const window = textMessagesAfter(state2.uptoMessageId, SUMMARY_TRIGGER + 60);
    if (!shouldSummarize(window.length)) return;
    const batch = window.slice(0, SUMMARY_BATCH);
    const transcript = batch.map((message) => `${message.role === "assistant" ? "你" : "对方"}：${message.contentMd}`).join("\n");
    const head = state2.summaryMd.trim();
    const prompt = head.length === 0 ? transcript : `旧摘要：${head}

新的对话：
${transcript}`;
    const { data } = await input.provider.chatJson({
      messages: [
        { role: "system", content: SUMMARIZE_SYSTEM },
        { role: "user", content: prompt }
      ],
      schema: summarySchema,
      temperature: 0,
      signal: controller.signal
    });
    const summaryMd = clip(data.summaryMd.trim());
    if (summaryMd.length === 0) return;
    setSummary({ summaryMd, uptoMessageId: batch[batch.length - 1].id });
  } catch (e) {
    console.warn("[ai] 摘要压缩失败，下轮再试", e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(timer);
  }
}
const CHAT_HISTORY_LIMIT = 20;
const CHAT_MEMORY_LIMIT = 12;
const CHAT_TEMPERATURE = 0.8;
const CHAT_MAX_TOKENS = 8e3;
const TONE_LINE = {
  warm: "说话温和、有耐心，不说教",
  plain: "直接说结论，不铺垫、不客套",
  playful: "轻松一点，可以开玩笑，但不油腻"
};
function identitySection(persona) {
  const parts = [`你是${persona.name}。`];
  const md = persona.personaMd.trim();
  if (md.length > 0) parts.push(md);
  const call = persona.userCall.trim();
  if (call.length > 0) parts.push(`称呼对方为「${call}」。`);
  parts.push(`语气：${TONE_LINE[persona.tone]}`);
  return parts.join("");
}
const MEMORY_USAGE_HINT = "这些是你已经知道的事。合适的时候自然地提一句，别一次全倒出来，也不要把这份清单念一遍。";
function memorySection(memories) {
  if (memories.length === 0) return null;
  return [
    "关于对方，你记得这些：",
    ...memories.map((item) => `- ${item.contentMd}`),
    MEMORY_USAGE_HINT
  ].join("\n");
}
function summarySection(summaryMd) {
  const text = summaryMd.trim();
  return text.length === 0 ? null : `更早的对话摘要：${text}`;
}
function buildChatSystem(input) {
  return [
    identitySection(input.persona),
    memorySection(input.memories),
    input.brief,
    summarySection(input.summaryMd),
    CHAT_RULES.trim()
  ].filter((section) => section !== null && section.length > 0).join("\n\n");
}
function buildChatRequest(input) {
  const history = input.recent.filter((message) => message.contentMd.trim().length > 0).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.contentMd
  }));
  return [
    { role: "system", content: buildChatSystem(input) },
    ...history,
    { role: "user", content: input.text }
  ];
}
async function runChat(input) {
  const persona = get$1();
  const memories = list$2().slice(0, CHAT_MEMORY_LIMIT);
  const yesterdayStat = dayStatOf(addDays(todayLocalDay(), -1));
  const brief = buildTodayBrief({
    tasks: listTasks({ status: ["todo", "doing", "pending_review", "reviewing"] }),
    stat: todayStat(),
    balance: balance(),
    yesterday: yesterdayStat
  });
  const state2 = get();
  const recent2 = recentChatMessages(CHAT_HISTORY_LIMIT, {
    excludeId: input.userMessageId
  });
  const messages = buildChatRequest({
    persona,
    memories,
    brief,
    summaryMd: state2.summaryMd,
    recent: recent2,
    text: input.text
  });
  const result = await input.provider.chatText({
    messages,
    temperature: CHAT_TEMPERATURE,
    maxTokens: CHAT_MAX_TOKENS
  });
  input.patchAssistant(input.assistantMessageId, {
    contentMd: result.text,
    status: "sent",
    tokensIn: result.usage.in,
    tokensOut: result.usage.out,
    latencyMs: result.latencyMs
  });
  if (memories.length > 0) touchHits(memories.map((item) => item.id));
  void runMemoryExtract({
    provider: input.provider,
    userText: input.text,
    assistantText: result.text
  });
  void maybeSummarize({ provider: input.provider });
}
const CHAT_LIMITS = {
  history: CHAT_HISTORY_LIMIT,
  memory: CHAT_MEMORY_LIMIT,
  temperature: CHAT_TEMPERATURE,
  maxTokens: CHAT_MAX_TOKENS
};
const taskTypeSchema$1 = zod.z.enum(["daily", "deadline", "event"]);
const difficultySchema$1 = zod.z.enum(["trivial", "easy", "medium", "hard", "epic"]);
const qualitySchema$1 = zod.z.enum(["partial", "met", "exceeded"]);
const eventResultSchema$1 = zod.z.enum(["exceeded", "met", "below"]);
const verdictSchema = zod.z.enum(["pass", "partial", "fail", "need_evidence"]);
const dueHintSchema = zod.z.string().refine((v) => duePrecisionOf(v) !== null, {
  message: 'due_hint 必须形如 2026-11-05T09:00:00+08:00 / 2026-11-05 / 2026-11，不要写"10月30日"这种无年份形态'
}).refine((v) => dueInstant(v) !== null, {
  message: "due_hint 不是合法日期（检查月份 1-12、日期是否超出当月天数）"
});
const dailyTimeSchema = zod.z.string().refine((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), {
  message: "daily_time_hint 必须是 24 小时制的 HH:mm"
});
const stepSchema = zod.z.object({
  title: zod.z.string().min(1, "步骤标题不能为空").max(40, "步骤标题最多 40 字"),
  estimate_min: zod.z.number().int().min(1).max(1440).nullable().optional()
}).strict();
const parsedTaskSchema = zod.z.object({
  type: taskTypeSchema$1,
  // 24 字是 prompt 的要求；schema 按落库上限（tasks.title 最多 40 字）兜底。
  // 比 40 更严会让一次"标题长了点"的输出把整批任务判失败，代价不成比例。
  title: zod.z.string().min(1, "标题不能为空").max(40, "标题最多 40 字"),
  detail_md: zod.z.string().max(2e3, "detail_md 最多 2000 字"),
  requires_evidence: zod.z.boolean(),
  difficulty: difficultySchema$1,
  estimate_min: zod.z.number().int().min(1).max(1440).nullable(),
  due_hint: dueHintSchema.nullable(),
  daily_time_hint: dailyTimeSchema.nullable(),
  tags: zod.z.array(zod.z.string().min(1).max(20)).max(8),
  steps: zod.z.array(stepSchema).max(10),
  missing_info: zod.z.array(zod.z.string().min(1).max(60)).max(5),
  confidence: zod.z.number().min(0).max(1)
}).strict().refine((v) => ALLOWED_DIFFICULTIES[v.type].includes(v.difficulty), {
  message: "任务类型与难度不匹配：daily 只能是 trivial/easy/medium，deadline 只能是 easy/medium/hard，event 只能是 medium/hard/epic。请重新判断类型或难度，不要凑一个合法组合"
});
const ParseResultSchema = zod.z.object({
  intent: zod.z.enum(["create_task", "review_task", "query", "chat"]),
  // 60 字是 prompt 的要求；schema 只挡"整段复述 JSON"这类失控输出，
  // 不想因为回复多了几个字就把一整批有效任务判失败
  reply: zod.z.string().min(1, "reply 不能为空").max(120, "reply 最多 120 字"),
  tasks: zod.z.array(parsedTaskSchema).max(10, "一次最多 10 个任务")
}).strict();
function reviewResultSchema(type) {
  const isEvent = type === "event";
  return zod.z.object({
    verdict: verdictSchema,
    quality: qualitySchema$1.nullable(),
    // event 的 result 必填；其他类型允许缺省或 null（toVerdict 统一归成 null）
    result: isEvent ? eventResultSchema$1 : zod.z.literal(null).optional(),
    // reason ≤50 字、followup ≤40 字是 03 §4.2 的明文条款，严格按它校验：
    // 这两个字段就是卡面上显示的那两行，超了会被 CSS 截断成"半句话"
    reason: zod.z.string().min(1, "reason 不能为空").max(50, "reason 最多 50 字"),
    followup: zod.z.string().max(40, "followup 最多 40 字").nullable(),
    // 03 §4.2 的输出示例里没有 gaps，但 domain.ts 的 ReviewVerdict 有（partial 时逐条列出）
    gaps: zod.z.array(zod.z.string().min(1).max(40)).max(5).optional()
  }).strict();
}
const ReviewResultSchema = zod.z.object({
  verdict: verdictSchema,
  quality: qualitySchema$1.nullable(),
  // 非 event 允许缺省（模型常常直接不写这个键），统一由 toVerdict 归成 null
  result: eventResultSchema$1.nullable().optional(),
  reason: zod.z.string().min(1).max(50),
  followup: zod.z.string().max(40).nullable(),
  gaps: zod.z.array(zod.z.string().min(1).max(40)).max(5).optional()
}).strict();
let injectedProvider = null;
let injectedKeyProbe = null;
function setProvider(provider) {
  injectedProvider = provider;
}
function setKeyProbe(probe) {
  injectedKeyProbe = probe;
}
function isConfigured() {
  if (injectedKeyProbe !== null) return injectedKeyProbe();
  if (injectedProvider !== null) return true;
  return readKey() !== null;
}
const CHAT_TIMEOUT_MS = 6e4;
let parseClient = null;
let chatClient = null;
function requireApiKey() {
  const apiKey = readKey();
  if (apiKey === null) {
    throw appError("AI_NOT_CONFIGURED", AI_COPY.notConfigured, { retryable: false });
  }
  return apiKey;
}
function parseProvider() {
  if (injectedProvider !== null) return injectedProvider;
  const apiKey = requireApiKey();
  const model = get$2("ai.provider").model;
  const baseUrl = get$2("ai.baseUrl");
  const key = `${apiKey}|${model}|${baseUrl}|parse`;
  if (parseClient === null || parseClient.key !== key) {
    parseClient = { key, client: new GlmClient({ apiKey, model, baseUrl }) };
  }
  return parseClient.client;
}
function chatProvider() {
  if (injectedProvider !== null) return injectedProvider;
  const apiKey = requireApiKey();
  const model = get$2("ai.chat.model");
  const baseUrl = get$2("ai.baseUrl");
  const key = `${apiKey}|${model}|${baseUrl}|chat`;
  if (chatClient === null || chatClient.key !== key) {
    chatClient = {
      key,
      client: new GlmClient({ apiKey, model, baseUrl, timeoutMs: CHAT_TIMEOUT_MS })
    };
  }
  return chatClient.client;
}
function currentProvider() {
  return parseProvider();
}
function backgroundProvider() {
  return chatProvider();
}
function broadcastAppended(message) {
  broadcast({ type: "message.appended", message });
}
function patchAssistant(id, patch2) {
  patchMessage(id, patch2);
  const visible = {};
  if (patch2.contentMd !== void 0) visible.contentMd = patch2.contentMd;
  if (patch2.status !== void 0) visible.status = patch2.status;
  if (patch2.meta !== void 0) visible.meta = patch2.meta;
  broadcast({ type: "message.patch", messageId: id, patch: visible });
}
function toAppError(e) {
  if (e instanceof AppErrorException) {
    const err = e.toAppError();
    return { code: err.code, message: err.message, retryable: err.retryable, detail: err.detail };
  }
  return {
    code: "UNKNOWN",
    message: "未知错误",
    retryable: false,
    detail: e instanceof Error ? e.message : String(e)
  };
}
function readImages(attachmentIds) {
  const images = [];
  for (const id of attachmentIds) {
    try {
      const { bytes, mime } = read(id);
      images.push({ mime, bytes });
    } catch (e) {
      console.warn("[ai] 附件读取失败，本轮跳过该附件", id, e instanceof Error ? e.message : e);
    }
  }
  return images;
}
function contextBefore(userMessageId) {
  const recent2 = recentMessages(20);
  const index = recent2.findIndex((m) => m.id === userMessageId);
  if (index <= 0) return [];
  return recent2.slice(0, index);
}
function send(input) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const attachmentIds = (input.attachmentIds ?? []).slice(0, 4);
  if (text.length === 0 && attachmentIds.length === 0) {
    throw appError("INVALID_INPUT", "请求参数格式不正确", {
      detail: "text 与 attachmentIds 同时为空"
    });
  }
  const created = appendMessage({
    role: "user",
    kind: "text",
    contentMd: text,
    status: "sent",
    // v0.73：模式落库，渲染层分层直接读标签，不再靠「这一轮有没有卡」猜
    mode: input.mode ?? "chat"
  });
  if (attachmentIds.length > 0) attachFiles(created.id, attachmentIds);
  const userMessage = requireMessage(created.id);
  broadcastAppended(userMessage);
  const assistant = appendMessage({
    role: "assistant",
    kind: "text",
    contentMd: "",
    status: "pending",
    mode: input.mode ?? "chat"
  });
  broadcastAppended(assistant);
  void runTurn({
    userMessageId: userMessage.id,
    assistantMessageId: assistant.id,
    text,
    attachmentIds,
    // 守卫已把缺省值落成 'chat'（`chatModeSchema.default('chat')`），这里不再写第二遍默认真值
    mode: input.mode ?? "chat"
  }).catch((e) => {
    console.error("[ai] 后台轮次异常逃逸", e);
  });
  return { userMessage, assistantMessageId: assistant.id };
}
function retry(input) {
  void runTurn(locateTurn(input.messageId)).catch((e) => {
    console.error("[ai] 重试轮次异常逃逸", e);
  });
}
function turnRangeOf(list2, startIndex) {
  if (startIndex < 0 || startIndex >= list2.length) return { start: startIndex, end: startIndex };
  for (let i = startIndex + 1; i < list2.length; i += 1) {
    if (list2[i].role === "user") return { start: startIndex, end: i };
  }
  return { start: startIndex, end: list2.length };
}
function removeTurn(input) {
  const list2 = listMessages({ limit: 60 });
  const index = list2.findIndex((m) => m.id === input.messageId);
  if (index === -1) throw appError("NOT_FOUND", "消息不存在", { detail: `id=${input.messageId}` });
  const target = list2[index];
  if (target.role !== "user" || target.kind !== "text") {
    throw appError("INVALID_INPUT", "请求参数格式不正确", {
      detail: `只能撤回自己发的文字消息，这条是 role=${target.role} kind=${target.kind}`
    });
  }
  const { start, end } = turnRangeOf(list2, index);
  const turn = list2.slice(start, end);
  const removedIds = turn.map((m) => m.id);
  const taskIds = /* @__PURE__ */ new Set();
  for (const message of turn) {
    if (message.meta.kind !== "task_draft") continue;
    for (const draft of message.meta.drafts) {
      const marker = draft;
      if (typeof marker.promotedTaskId === "string") taskIds.add(marker.promotedTaskId);
    }
  }
  tx(() => {
    for (const taskId of taskIds) {
      try {
        removeTask(taskId);
      } catch (e) {
        console.warn("[ai] 撤回时软删任务失败，继续", taskId, e instanceof Error ? e.message : e);
      }
    }
    removeMany(removedIds);
  });
  for (const taskId of taskIds) broadcast({ type: "task.removed", taskId });
  return { removedIds, removedTaskIds: [...taskIds] };
}
function locateTurn(messageId) {
  const list2 = listMessages({ limit: 60 });
  const index = list2.findIndex((m) => m.id === messageId);
  if (index === -1) throw appError("NOT_FOUND", "消息不存在", { detail: `id=${messageId}` });
  let userIndex = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (list2[i].role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) {
    throw appError("INVALID_INPUT", "请求参数格式不正确", {
      detail: "这条消息之前没有用户输入，无法重试"
    });
  }
  const userMessage = list2[userIndex];
  const mode = userMessage.mode ?? "task";
  const existing = list2.slice(userIndex + 1, index).find((m) => m.role === "assistant" && m.kind !== "error");
  let assistantMessageId;
  if (existing) {
    assistantMessageId = existing.id;
  } else {
    const created = appendMessage({
      role: "assistant",
      kind: "text",
      contentMd: "",
      status: "pending",
      mode
    });
    broadcastAppended(created);
    assistantMessageId = created.id;
  }
  return {
    userMessageId: userMessage.id,
    assistantMessageId,
    text: userMessage.contentMd,
    attachmentIds: listAttachments(userMessage.id).map((item) => item.id),
    mode
  };
}
function appendDraftMessage(drafts, mode) {
  const message = appendMessage({
    role: "assistant",
    kind: "task_draft",
    contentMd: "",
    meta: { kind: "task_draft", drafts },
    status: "sent",
    mode
  });
  broadcastAppended(message);
}
async function runTurn(input) {
  broadcast({ type: "ai.status", phase: "thinking", messageId: input.assistantMessageId });
  try {
    if (input.mode === "chat") {
      await runChat({
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        text: input.text,
        provider: chatProvider(),
        patchAssistant
      });
      return;
    }
    const provider = currentProvider();
    const cfg = pointsConfig();
    const request = buildParseRequest({
      text: input.text,
      images: readImages(input.attachmentIds),
      recent: contextBefore(input.userMessageId)
    });
    const { data, usage, latencyMs } = await provider.chatJson({
      messages: request.messages,
      schema: ParseResultSchema,
      // v0.52：建任务的判定规则在 prompt 里写得很死，浅推理就够。实测默认档 82.6s →
      // 7.4s，五类边界输入（复杂日期换算 / 闲聊 / 完成回报 / 信息不足 / 超 10 件）判定一致。
      // 首次没过 schema 时 glmClient 会把重试那次升到 high。
      reasoningEffort: "low"
    });
    const drafts = toTaskDrafts(data, cfg);
    patchAssistant(input.assistantMessageId, {
      contentMd: withImageNote(data.reply, request.droppedImages),
      status: "sent",
      tokensIn: usage.in,
      tokensOut: usage.out,
      latencyMs
    });
    if (drafts.length > 0) appendDraftMessage(drafts, input.mode);
  } catch (e) {
    handleTurnFailure(e, input.assistantMessageId, input.mode);
  } finally {
    broadcast({ type: "ai.status", phase: "idle", messageId: input.assistantMessageId });
  }
}
function handleTurnFailure(e, assistantMessageId, mode) {
  if (isAbortError(e)) {
    patchAssistant(assistantMessageId, { status: "failed" });
    return;
  }
  const error = toAppError(e);
  console.error("[ai] 本轮失败", error.code, error.detail ?? error.message);
  try {
    patchAssistant(assistantMessageId, { status: "failed" });
  } catch (patchError) {
    console.error("[ai] 占位消息标记失败", patchError);
  }
  const message = appendMessage({
    role: "system",
    kind: "error",
    contentMd: "",
    meta: {
      kind: "error",
      code: error.code,
      message: error.message,
      retryable: error.retryable
    },
    // 跟随本轮的模式：这一轮是按什么模式发的，错误气泡就属于哪一层
    mode
  });
  broadcastAppended(message);
}
function newOccurrences(before, after) {
  const known = new Set(before.map((o) => o.id));
  return after.filter((o) => !known.has(o.id));
}
function confirmDraft(input) {
  const today = todayLocalDay();
  const rangeTo = addDays(today, 3);
  const before = listRangeRaw(today, rangeTo);
  const { task, created } = promoteDraft(input);
  if (!created) return task;
  const createdOccurrences = newOccurrences(
    before,
    listRangeRaw(today, rangeTo)
  ).filter((o) => o.day === today);
  broadcast({ type: "task.created", task });
  for (const sub of listTasks({ parentId: task.id })) {
    broadcast({ type: "task.created", task: sub });
  }
  if (createdOccurrences.length > 0) {
    broadcast({ type: "occurrence.created", occurrences: createdOccurrences });
  }
  const message = requireMessage(input.messageId);
  broadcast({ type: "message.patch", messageId: input.messageId, patch: { meta: message.meta } });
  broadcast({ type: "daystats.changed", day: getDay(today) });
  return task;
}
function rejectDrafts(input) {
  const message = requireMessage(input.messageId);
  if (message.meta.kind !== "task_draft") {
    throw appError("INVALID_INPUT", "请求参数格式不正确", {
      detail: `消息 ${input.messageId} 的 meta.kind=${message.meta.kind}，不是 task_draft`
    });
  }
  const drop = new Set(input.localIds);
  const remain = message.meta.drafts.filter((draft) => !drop.has(draft.localId));
  if (remain.length === message.meta.drafts.length) {
    throw appError("INVALID_INPUT", "请求参数格式不正确", {
      detail: `消息 ${input.messageId} 里没有这些草稿：${input.localIds.join(",")}`
    });
  }
  const meta = { kind: "task_draft", drafts: remain };
  patchMessage(input.messageId, { meta });
  broadcast({ type: "message.patch", messageId: input.messageId, patch: { meta } });
}
function reviewEvidenceOf(evidence) {
  return evidence.map((item) => {
    if (item.kind === "text") return { kind: "text", text: item.text };
    try {
      const { bytes, mime } = read(item.attachmentId);
      return mime.startsWith("image/") ? { kind: "image", mime, bytes } : { kind: "file", mime };
    } catch (e) {
      console.warn("[ai] 证据附件读取失败", item.attachmentId, e instanceof Error ? e.message : e);
      return { kind: "file", mime: "application/octet-stream" };
    }
  });
}
function appendReviewMessage(task, verdict) {
  const message = appendMessage({
    role: "assistant",
    kind: "task_review",
    contentMd: verdict.reason,
    linkedTaskId: task.id,
    meta: { kind: "task_review", taskId: task.id, verdict },
    status: "sent",
    // 审核卡是任务审核的产物，与用户当时用的输入模式无关，恒为 'task'
    mode: "task"
  });
  broadcastAppended(message);
}
function appendReviewIfReviewing(task, verdict) {
  let fresh;
  try {
    fresh = requireTask(task.id);
  } catch (e) {
    console.warn("[ai] review 结果无法落卡（任务读不到）", task.id, e instanceof Error ? e.message : e);
    return;
  }
  if (fresh.status !== "reviewing") {
    console.warn(
      `[ai] review 结果作废：任务已不在待确认（status=${fresh.status}），不落卡 task=${task.id}`
    );
    return;
  }
  appendReviewMessage(task, verdict);
}
async function review(input) {
  const task = requireTask(input.taskId);
  const evidence = reviewEvidenceOf(task.evidence);
  const gate = hardGateOf(task, evidence.length);
  if (gate !== null) {
    console.log(`[ai] review 硬闸门命中，未发请求 task=${task.id}`);
    appendReviewIfReviewing(task, gate);
    return gate;
  }
  const provider = currentProvider();
  const { data } = await provider.chatJson({
    messages: buildReviewRequest({ task, evidence, userText: input.userText }),
    schema: reviewResultSchema(task.type)
  });
  const verdict = toVerdict(data, task.type);
  appendReviewIfReviewing(task, verdict);
  return verdict;
}
const PROBE_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const ProbeSchema = zod.z.object({ color: zod.z.string() }).strict();
let probePromise = null;
async function probeMultimodal() {
  try {
    const provider = currentProvider();
    const { data } = await provider.chatJson({
      messages: [
        { role: "system", content: "你只能输出一个 JSON 对象，不要任何解释。" },
        {
          role: "user",
          content: [
            { type: "text", text: '这张图片主要是什么颜色？只输出 {"color":"颜色"}。' },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` }
            }
          ]
        }
      ],
      schema: ProbeSchema,
      maxRetries: 0
    });
    return /红|red/i.test(data.color);
  } catch (e) {
    console.warn("[ai] 多模态探测失败", toAppError(e).code);
    return null;
  }
}
function keyStatus() {
  return { configured: isConfigured() };
}
function setKey(key) {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw appError("INVALID_INPUT", "API Key 不能为空");
  }
  if (!writeKey(trimmed)) {
    throw appError("INVALID_INPUT", "API Key 保存失败");
  }
  return { configured: isConfigured() };
}
async function health() {
  const model = get$2("ai.provider").model;
  if (!isConfigured()) return { configured: false, model, multimodal: null };
  if (probePromise === null) probePromise = probeMultimodal();
  return { configured: true, model, multimodal: await probePromise };
}
function resetForTest() {
  injectedProvider = null;
  injectedKeyProbe = null;
  probePromise = null;
}
const aiService = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  backgroundProvider,
  confirmDraft,
  health,
  keyStatus,
  rejectDrafts,
  removeTurn,
  resetForTest,
  retry,
  review,
  send,
  setKey,
  setKeyProbe,
  setProvider,
  turnRangeOf
}, Symbol.toStringTag, { value: "Module" }));
const SELECT_ALERT = `SELECT ${ALERT_COLUMNS.join(", ")} FROM alerts`;
function write$1(fn) {
  try {
    return fn();
  } catch (e) {
    throw wrapWriteError(e, "提醒记录写入失败");
  }
}
function selectById(id) {
  const row2 = getDb().prepare(`${SELECT_ALERT} WHERE id = ?`).get(id);
  return row2 ? mapAlert(row2) : null;
}
function insert$1(input) {
  write$1(
    () => getDb().prepare(`INSERT INTO alerts (${ALERT_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id,
      input.kind,
      input.level,
      input.sourceId,
      input.title,
      input.firedAt,
      null,
      null
    )
  );
  const alert = selectById(input.id);
  if (alert === null) throw appError("DB_ERROR", "提醒记录写入失败", { detail: `id=${input.id}` });
  return alert;
}
function ackBySourceId(sourceId, at) {
  return write$1(
    () => getDb().prepare("UPDATE alerts SET acked_at = ? WHERE source_id = ? AND acked_at IS NULL").run(at, sourceId).changes
  );
}
function escalateDue$1(normalBefore, strongBefore, at) {
  return write$1(
    () => getDb().prepare(
      `UPDATE alerts SET escalated_at = ?
         WHERE acked_at IS NULL AND escalated_at IS NULL
           AND ((level = 'strong' AND fired_at <= ?) OR (level <> 'strong' AND fired_at <= ?))`
    ).run(at, strongBefore, normalBefore).changes
  );
}
function listSince$1(sinceIso) {
  return getDb().prepare(`${SELECT_ALERT} WHERE fired_at >= ? ORDER BY fired_at ASC`).all(sinceIso).map(mapAlert);
}
function listRecent(limit) {
  return getDb().prepare(`${SELECT_ALERT} ORDER BY fired_at DESC LIMIT ?`).all(limit).map(mapAlert);
}
const ESCALATE_NORMAL_MS = 1e4;
const ESCALATE_STRONG_MS = 6e4;
function recordAlert(input) {
  return insert$1({
    id: node_crypto.randomUUID(),
    kind: "reminder",
    level: input.level,
    sourceId: input.sourceId,
    title: input.title,
    firedAt: nowIso()
  });
}
function ackAlert(sourceId) {
  return ackBySourceId(sourceId, nowIso());
}
function escalateDue(now) {
  const normalBefore = new Date(now.getTime() - ESCALATE_NORMAL_MS).toISOString();
  const strongBefore = new Date(now.getTime() - ESCALATE_STRONG_MS).toISOString();
  return escalateDue$1(normalBefore, strongBefore, now.toISOString());
}
function listSince(sinceMs, now) {
  return listSince$1(new Date(now.getTime() - sinceMs).toISOString());
}
const SELECT_PULSE = `SELECT ${PULSE_COLUMNS.join(", ")} FROM pulses`;
function write(fn) {
  try {
    return fn();
  } catch (e) {
    throw wrapWriteError(e, "周期提醒写入失败");
  }
}
function listAll() {
  return getDb().prepare(`${SELECT_PULSE} ORDER BY created_at ASC`).all().map(mapPulse);
}
function listEnabled() {
  return getDb().prepare(`${SELECT_PULSE} WHERE enabled = 1 ORDER BY created_at ASC`).all().map(mapPulse);
}
function getById(id) {
  const row2 = getDb().prepare(`${SELECT_PULSE} WHERE id = ?`).get(id);
  return row2 ? mapPulse(row2) : null;
}
function requireById(id) {
  const pulse = getById(id);
  if (!pulse) throw appError("NOT_FOUND", "这一项不存在", { detail: `id=${id}` });
  return pulse;
}
function insert(input) {
  write(() => {
    getDb().prepare(
      `INSERT INTO pulses (${PULSE_COLUMNS.join(", ")})
         VALUES (${placeholders(PULSE_COLUMNS.length)})`
    ).run(
      input.id,
      input.title,
      input.intervalMinutes,
      input.windowStart ?? null,
      input.windowEnd ?? null,
      1,
      null,
      input.now,
      input.now
    );
  });
  return requireById(input.id);
}
function setEnabled$1(id, enabled, updatedAt) {
  const changes = write(
    () => getDb().prepare("UPDATE pulses SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, updatedAt, id).changes
  );
  if (changes === 0) requireById(id);
  return requireById(id);
}
function remove$1(id) {
  const changes = write(
    () => getDb().prepare("DELETE FROM pulses WHERE id = ?").run(id).changes
  );
  if (changes === 0) requireById(id);
}
function markFired(id, firedAt) {
  write(() => {
    const changes = getDb().prepare("UPDATE pulses SET last_fired_at = ?, updated_at = ? WHERE id = ?").run(firedAt, firedAt, id).changes;
    if (changes === 0) requireById(id);
  });
}
function resetLastFired(firedAt) {
  return write(
    () => getDb().prepare("UPDATE pulses SET last_fired_at = ? WHERE enabled = 1").run(firedAt).changes
  );
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function inWindow(hhmm, start, end) {
  if (start === null || end === null) return true;
  if (start === end) return true;
  if (start < end) return start <= hhmm && hhmm < end;
  return hhmm >= start || hhmm < end;
}
function localHhmm(now) {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function isDue(pulse, now) {
  if (!pulse.enabled) return false;
  if (!inWindow(localHhmm(now), pulse.windowStart, pulse.windowEnd)) return false;
  if (pulse.lastFiredAt === null) return true;
  return now.getTime() - Date.parse(pulse.lastFiredAt) >= pulse.intervalMinutes * 6e4;
}
function normalizeWindow(value) {
  return value === void 0 || value === null || value === "" ? null : value;
}
function list() {
  return listAll();
}
function create(input) {
  const title = input.title.trim();
  if (title === "") throw appError("INVALID_INPUT", "标题不能为空");
  if (title.length > 40) throw appError("INVALID_INPUT", "标题不能超过 40 个字");
  const interval = input.intervalMinutes;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
    throw appError("INVALID_INPUT", "间隔必须在 1 到 1440 分钟之间");
  }
  const windowStart = normalizeWindow(input.windowStart);
  const windowEnd = normalizeWindow(input.windowEnd);
  if (windowStart === null !== (windowEnd === null)) {
    throw appError("INVALID_INPUT", "提醒区间要么都填，要么都不填");
  }
  if (windowStart !== null && !HHMM.test(windowStart)) {
    throw appError("INVALID_INPUT", "时间格式应为 HH:mm");
  }
  if (windowEnd !== null && !HHMM.test(windowEnd)) {
    throw appError("INVALID_INPUT", "时间格式应为 HH:mm");
  }
  return insert({
    id: newId(),
    now: nowIso(),
    title,
    intervalMinutes: interval,
    windowStart,
    windowEnd
  });
}
function setEnabled(id, enabled) {
  return setEnabled$1(id, enabled, nowIso());
}
function remove(id) {
  remove$1(id);
}
const EDIT_MENU_LABELS = ["剪切", "复制", "粘贴", "全选"];
function buildEditMenuTemplate(flags) {
  return [
    { label: EDIT_MENU_LABELS[0], enabled: flags.canCut },
    { label: EDIT_MENU_LABELS[1], enabled: flags.canCopy },
    { label: EDIT_MENU_LABELS[2], enabled: flags.canPaste },
    { label: EDIT_MENU_LABELS[3], enabled: flags.canSelectAll, separatorBefore: true }
  ];
}
let lastMenu = null;
function installContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    const actions = [
      () => win.webContents.cut(),
      () => win.webContents.copy(),
      () => win.webContents.paste(),
      () => win.webContents.selectAll()
    ];
    const template = [];
    buildEditMenuTemplate(params.editFlags).forEach((item, index) => {
      if (item.separatorBefore === true) template.push({ type: "separator" });
      template.push({ label: item.label, enabled: item.enabled, click: actions[index] });
    });
    lastMenu = electron.Menu.buildFromTemplate(template);
    lastMenu.popup({ window: win });
  });
}
const BALL_W = 132;
const BALL_H = 40;
const PANEL_W = 360;
const PANEL_H = 480;
const PANEL_MIN_W = 280;
const PANEL_MIN_H = 320;
const PANEL_MAX_W = 720;
const PANEL_MAX_H = 900;
const TOP_RATIO = 0.1;
const EXPAND_GAP_RATIO = 1 / 8;
function expandGap(workArea) {
  return Math.round(workArea.width * EXPAND_GAP_RATIO);
}
const PANEL_COLLAPSE_RATIO = 1 / 3;
const MOVE_JUDGE_MS = 120;
const SETTLE_MS = 300;
const ECHO_TOLERANCE = 2;
const DEFAULT_PANEL_SIZE = { width: PANEL_W, height: PANEL_H };
function clampInto(workArea, rect) {
  const maxX = workArea.x + workArea.width - rect.width;
  const maxY = workArea.y + workArea.height - rect.height;
  const x = Math.min(Math.max(rect.x, workArea.x), Math.max(workArea.x, maxX));
  const y = Math.min(Math.max(rect.y, workArea.y), Math.max(workArea.y, maxY));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}
function clampSize(size) {
  const width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(size.width)));
  const height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, Math.round(size.height)));
  return { width, height };
}
function clampOpacity(value) {
  const clamped = Math.min(1, Math.max(0.3, value));
  return Math.round(clamped * 100) / 100;
}
function fitSize(workArea, size) {
  const clamped = clampSize(size);
  return {
    width: Math.max(1, Math.min(clamped.width, workArea.width)),
    height: Math.max(1, Math.min(clamped.height, workArea.height))
  };
}
function clampBallPoint(workArea, point) {
  const rect = clampInto(workArea, { ...point, width: BALL_W, height: BALL_H });
  return { x: rect.x, y: rect.y };
}
function initialBallPoint(workArea) {
  return clampBallPoint(workArea, {
    x: workArea.x + workArea.width - BALL_W,
    y: workArea.y + Math.round(workArea.height * TOP_RATIO)
  });
}
function ballBounds(workArea, point) {
  const { x, y } = clampBallPoint(workArea, point);
  return { x, y, width: BALL_W, height: BALL_H };
}
function peekPanelBounds(workArea, ball, size) {
  const { width, height } = fitSize(workArea, size);
  const rightHalf = ball.x + BALL_W / 2 >= workArea.x + workArea.width / 2;
  const x = rightHalf ? ball.x + BALL_W - width : ball.x;
  return clampInto(workArea, { x, y: ball.y, width, height });
}
function ballFromPanel(workArea, rect, side) {
  const x = side === "left" ? workArea.x : workArea.x + workArea.width - BALL_W;
  return clampBallPoint(workArea, { x, y: rect.y });
}
function edgeGap(workArea, rect) {
  const left = rect.x - workArea.x;
  const right = workArea.x + workArea.width - (rect.x + rect.width);
  return Math.min(left, right);
}
function offscreenOf(workArea, rect) {
  return {
    left: Math.max(0, workArea.x - rect.x),
    right: Math.max(0, rect.x + rect.width - (workArea.x + workArea.width))
  };
}
function resolveDragStep(mode, workArea, rect) {
  if (mode === "ball") return edgeGap(workArea, rect) > expandGap(workArea) ? "expand" : "none";
  const { left, right } = offscreenOf(workArea, rect);
  const limit = rect.width * PANEL_COLLAPSE_RATIO;
  if (left > limit && left >= right) return "collapse-left";
  if (right > limit) return "collapse-right";
  return "none";
}
let port = null;
let displays = null;
let state = null;
let anchor = { x: 0, y: 0 };
let panelSize = { ...DEFAULT_PANEL_SIZE };
let expectedRect = null;
let judgeTimer = null;
let settleTimer = null;
let sizeDirty = false;
function requirePort() {
  if (!port) throw new Error("HUD 窗口尚未创建（hudService.attach 未被调用）");
  return port;
}
function requireDisplays() {
  if (!displays) throw new Error("HUD 显示器端口尚未注入（hudService.attach 未被调用）");
  return displays;
}
function requireState() {
  if (!state) throw new Error("HUD 状态尚未初始化（hudService.attach 未被调用）");
  return state;
}
function clearTimers() {
  if (judgeTimer) {
    clearTimeout(judgeTimer);
    judgeTimer = null;
  }
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}
function normalizeMode(raw) {
  return raw === "panel" ? "panel" : "ball";
}
function pointFor(mode, workArea, size, point) {
  if (mode === "ball") return clampBallPoint(workArea, point);
  const rect = clampInto(workArea, { ...point, ...size });
  return { x: rect.x, y: rect.y };
}
function panelBounds(workArea, size, point) {
  const full = clampInto(workArea, { ...point, width: size.width, height: size.height });
  return { x: Math.round(point.x), y: full.y, width: full.width, height: full.height };
}
function boundsFor(mode, workArea, size, point) {
  return mode === "ball" ? ballBounds(workArea, point) : panelBounds(workArea, size, point);
}
function resolveLayout(displayPort) {
  const area = displayPort.workAreaOf(get$2("hud.displayId"));
  const mode = normalizeMode(get$2("hud.mode"));
  const size = fitSize(area.workArea, get$2("hud.size") ?? DEFAULT_PANEL_SIZE);
  const stored = get$2("hud.position");
  const anchor2 = stored.x === null || stored.y === null ? pointFor(mode, area.workArea, size, initialBallPoint(area.workArea)) : pointFor(mode, area.workArea, size, { x: stored.x, y: stored.y });
  return { mode, displayId: area.displayId, workArea: area.workArea, anchor: anchor2, size };
}
function resolveInitialBounds(displayPort) {
  const layout = resolveLayout(displayPort);
  return boundsFor(layout.mode, layout.workArea, layout.size, layout.anchor);
}
function applyWindowMode(mode) {
  const target = requirePort();
  target.setMovable(true);
  if (mode === "panel") {
    target.setResizable(true);
    target.setMinSize(PANEL_MIN_W, PANEL_MIN_H);
    target.setMaxSize(PANEL_MAX_W, PANEL_MAX_H);
    return;
  }
  target.setMinSize(0, 0);
  target.setMaxSize(0, 0);
  target.setResizable(false);
}
function applyBounds() {
  const current2 = requireState();
  const area = requireDisplays().workAreaOf(current2.displayId);
  const next = boundsFor(current2.mode, area.workArea, panelSize, anchor);
  current2.bounds = next;
  expectedRect = next;
  requirePort().setBounds(next);
}
function persistDisplayId(displayId) {
  if (get$2("hud.displayId") !== displayId) set("hud.displayId", displayId);
}
function persistPosition(point) {
  const stored = get$2("hud.position");
  if (stored.x !== point.x || stored.y !== point.y) {
    set("hud.position", { x: point.x, y: point.y });
  }
}
function persistSize(size) {
  const stored = get$2("hud.size");
  if (!stored || stored.width !== size.width || stored.height !== size.height) {
    set("hud.size", { width: size.width, height: size.height });
  }
}
function enterMode(mode, area, point) {
  const current2 = requireState();
  current2.mode = mode;
  current2.displayId = area.displayId;
  anchor = pointFor(mode, area.workArea, panelSize, point);
  applyWindowMode(mode);
  applyBounds();
  set("hud.mode", mode);
  persistPosition(anchor);
  persistDisplayId(area.displayId);
  broadcast({ type: "hud.mode.changed", mode });
}
function attach(windowPort, displaysPort) {
  detach();
  port = windowPort;
  displays = displaysPort;
  const layout = resolveLayout(displaysPort);
  state = {
    mode: layout.mode,
    visible: true,
    displayId: layout.displayId,
    bounds: boundsFor(layout.mode, layout.workArea, layout.size, layout.anchor)
  };
  anchor = layout.anchor;
  panelSize = layout.size;
  applyWindowMode(layout.mode);
  applyBounds();
  windowPort.onMove(handleWindowMove);
  windowPort.onResize(handleWindowResize);
  persistDisplayId(layout.displayId);
}
function detach() {
  clearTimers();
  port = null;
  displays = null;
  state = null;
  anchor = { x: 0, y: 0 };
  panelSize = { ...DEFAULT_PANEL_SIZE };
  expectedRect = null;
  sizeDirty = false;
}
function handleWindowMove() {
  if (!port || !state) return;
  const rect = port.getBounds();
  if (expectedRect && Math.abs(rect.x - expectedRect.x) <= ECHO_TOLERANCE && Math.abs(rect.y - expectedRect.y) <= ECHO_TOLERANCE) {
    return;
  }
  expectedRect = null;
  if (judgeTimer) clearTimeout(judgeTimer);
  judgeTimer = setTimeout(judgeShape, MOVE_JUDGE_MS);
  scheduleSettle();
}
function handleWindowResize() {
  if (!port || !state) return;
  const rect = port.getBounds();
  if (expectedRect && Math.abs(rect.width - expectedRect.width) <= ECHO_TOLERANCE && Math.abs(rect.height - expectedRect.height) <= ECHO_TOLERANCE) {
    return;
  }
  sizeDirty = true;
  scheduleSettle();
}
function scheduleSettle() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, SETTLE_MS);
}
function judgeShape() {
  judgeTimer = null;
  if (!port || !state) return;
  const rect = port.getBounds();
  const area = requireDisplays().nearestWorkArea(rect);
  const step = resolveDragStep(state.mode, area.workArea, rect);
  if (step === "none") return;
  if (step === "expand") {
    const next = peekPanelBounds(area.workArea, { x: rect.x, y: rect.y }, panelSize);
    enterMode("panel", area, { x: next.x, y: next.y });
    return;
  }
  const side = step === "collapse-left" ? "left" : "right";
  enterMode("ball", area, ballFromPanel(area.workArea, rect, side));
}
function settle() {
  settleTimer = null;
  if (!port || !state) return;
  const rect = port.getBounds();
  const area = requireDisplays().nearestWorkArea(rect);
  const step = resolveDragStep(state.mode, area.workArea, rect);
  if (step === "expand") {
    const next = peekPanelBounds(area.workArea, { x: rect.x, y: rect.y }, panelSize);
    enterMode("panel", area, { x: next.x, y: next.y });
    return;
  }
  if (step === "collapse-left" || step === "collapse-right") {
    const side = step === "collapse-left" ? "left" : "right";
    enterMode("ball", area, ballFromPanel(area.workArea, rect, side));
    return;
  }
  const resized = state.mode === "panel" && sizeDirty;
  if (resized) {
    panelSize = fitSize(area.workArea, { width: rect.width, height: rect.height });
  }
  sizeDirty = false;
  const clamped = boundsFor(state.mode, area.workArea, panelSize, { x: rect.x, y: rect.y });
  state.displayId = area.displayId;
  anchor = { x: clamped.x, y: clamped.y };
  persistPosition(anchor);
  persistDisplayId(area.displayId);
  if (resized) persistSize(panelSize);
  const moved = Math.abs(clamped.x - rect.x) > ECHO_TOLERANCE || Math.abs(clamped.y - rect.y) > ECHO_TOLERANCE || Math.abs(clamped.width - rect.width) > ECHO_TOLERANCE || Math.abs(clamped.height - rect.height) > ECHO_TOLERANCE;
  if (moved) applyBounds();
  else state.bounds = clamped;
}
function setMode(mode) {
  const current2 = requireState();
  if (current2.mode === mode) return;
  const area = requireDisplays().workAreaOf(current2.displayId);
  if (mode === "panel") {
    const next = peekPanelBounds(area.workArea, anchor, panelSize);
    enterMode("panel", area, { x: next.x, y: next.y });
    return;
  }
  enterMode("ball", area, clampBallPoint(area.workArea, anchor));
}
function moveTo(x, y) {
  const current2 = requireState();
  const area = requireDisplays().nearestWorkArea({
    x,
    y,
    width: current2.mode === "ball" ? BALL_W : panelSize.width,
    height: current2.mode === "ball" ? BALL_H : panelSize.height
  });
  anchor = pointFor(current2.mode, area.workArea, panelSize, { x, y });
  current2.displayId = area.displayId;
  persistPosition(anchor);
  persistDisplayId(area.displayId);
  applyBounds();
}
function dragBegin() {
  const rect = requirePort().getBounds();
  return { x: rect.x, y: rect.y };
}
function dragTo(x, y, end) {
  const current2 = requireState();
  if (current2.mode !== "ball") return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const area = requireDisplays().nearestWorkArea({ x, y, width: BALL_W, height: BALL_H });
  anchor = clampBallPoint(area.workArea, { x, y });
  current2.displayId = area.displayId;
  if (!end) {
    applyBounds();
    return;
  }
  persistPosition(anchor);
  persistDisplayId(area.displayId);
  const step = resolveDragStep("ball", area.workArea, {
    x: anchor.x,
    y: anchor.y,
    width: BALL_W,
    height: BALL_H
  });
  if (step === "expand") {
    const panel = peekPanelBounds(area.workArea, anchor, panelSize);
    enterMode("panel", area, { x: panel.x, y: panel.y });
    return;
  }
  applyBounds();
}
function setVisible(visible) {
  const current2 = requireState();
  const target = requirePort();
  current2.visible = visible;
  broadcast({ type: "hud.visible.changed", visible });
  if (visible) target.showInactive();
  else target.hide();
}
function getState() {
  const current2 = requireState();
  return {
    mode: current2.mode,
    displayId: current2.displayId,
    visible: current2.visible && !requirePort().isDestroyed()
  };
}
function syncDisplays() {
  const current2 = requireState();
  const area = requireDisplays().workAreaOf(current2.displayId);
  current2.displayId = area.displayId;
  panelSize = fitSize(area.workArea, panelSize);
  anchor = pointFor(current2.mode, area.workArea, panelSize, anchor);
  persistDisplayId(area.displayId);
  persistPosition(anchor);
  if (current2.mode === "panel") persistSize(panelSize);
  applyBounds();
}
const preloadPath = node_path.join(__dirname, "../preload/index.js");
function loadRenderer(win, page) {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}/${page}/index.html`);
    return;
  }
  void win.loadFile(node_path.join(__dirname, `../renderer/${page}/index.html`));
}
const webPreferences = {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
};
let mainWindow = null;
function createMainWindow(options = {}) {
  const showOnReady = options.show ?? true;
  const win = new electron.BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 560,
    show: false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences
  });
  mainWindow = win;
  installContextMenu(win);
  win.once("ready-to-show", () => {
    if (showOnReady) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  loadRenderer(win, "main");
  return win;
}
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
function showMainWindow() {
  const win = getMainWindow();
  if (!win) {
    const created = createMainWindow();
    created.once("ready-to-show", () => {
      created.show();
      created.moveTop();
      created.focus();
    });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
}
let hudWindow = null;
function hudDisplaysPort() {
  const toArea = (display) => ({
    displayId: display.id,
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
  });
  return {
    // 记忆的显示器不在了（拔屏 / displayId 为 null）→ 回落主屏（04 §8）
    workAreaOf(displayId) {
      const found = displayId === null ? void 0 : electron.screen.getAllDisplays().find((d) => d.id === displayId);
      return toArea(found ?? electron.screen.getPrimaryDisplay());
    },
    nearestWorkArea(rect) {
      return toArea(electron.screen.getDisplayMatching(rect));
    }
  };
}
function hudWindowPort(win) {
  return {
    // 用 content bounds 而不是 outer bounds：Windows 给无边框可拉伸窗口加了一圈隐形边框，
    // `setBounds(360)` 回读是 362，反复"请求 = 回读"会让面板每开一次胖 2px（实测 372→374→376）。
    // content bounds 就是渲染层真实可视区域，和 CSS 的 100% 一一对应。
    getBounds: () => win.getContentBounds(),
    setBounds: (rect) => {
      if (!win.isDestroyed()) win.setContentBounds(rect);
    },
    setMovable: (movable) => {
      if (!win.isDestroyed()) win.setMovable(movable);
    },
    // 形态能力（04 §5.1）：面板可拉伸 + 上下限，长条固定 132×40。
    // 上下限必须动态设：建窗时就写 minWidth=280 的话，长条 setBounds 到 132 会被系统夹住。
    setResizable: (resizable) => {
      if (!win.isDestroyed()) win.setResizable(resizable);
    },
    setMinSize: (width, height) => {
      if (!win.isDestroyed()) win.setMinimumSize(width, height);
    },
    setMaxSize: (width, height) => {
      if (!win.isDestroyed()) win.setMaximumSize(width, height);
    },
    hide: () => {
      if (!win.isDestroyed()) win.hide();
    },
    showInactive: () => {
      if (!win.isDestroyed()) win.showInactive();
    },
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    onMove: (listener) => {
      win.on("move", () => listener());
    },
    onResize: (listener) => {
      win.on("resize", () => listener());
    },
    isDestroyed: () => win.isDestroyed()
  };
}
function getHudWindow() {
  return hudWindow && !hudWindow.isDestroyed() ? hudWindow : null;
}
function createHudWindow() {
  const displays2 = hudDisplaysPort();
  const bounds = resolveInitialBounds(displays2);
  const win = new electron.BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    // 长条与面板都可拖（面板只有头部是 drag 区），attach 里仍按形态调一次
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    focusable: true,
    show: false,
    webPreferences
  });
  hudWindow = win;
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.setVisibleOnAllWorkspaces(true);
  win.once("ready-to-show", () => win.showInactive());
  attach(hudWindowPort(win), displays2);
  const onDisplayChanged = () => {
    syncDisplays();
  };
  electron.screen.on("display-added", onDisplayChanged);
  electron.screen.on("display-removed", onDisplayChanged);
  electron.screen.on("display-metrics-changed", onDisplayChanged);
  win.on("closed", () => {
    electron.screen.removeListener("display-added", onDisplayChanged);
    electron.screen.removeListener("display-removed", onDisplayChanged);
    electron.screen.removeListener("display-metrics-changed", onDisplayChanged);
    detach();
    if (hudWindow === win) hudWindow = null;
  });
  loadRenderer(win, "hud");
  return win;
}
const NOTICE_QUEUE_MAX = 5;
const LIGHT_HEIGHT = 88;
const STRONG_WIDTH = 480;
const STRONG_HEIGHT = 300;
let current = null;
const queue = [];
function boundsOf(level) {
  const area = electron.screen.getPrimaryDisplay().workArea;
  const strong = level === "strong";
  const width = strong ? STRONG_WIDTH : Math.round(area.width * 0.3);
  const height = strong ? STRONG_HEIGHT : LIGHT_HEIGHT;
  const x = area.x + Math.round((area.width - width) / 2);
  const y = strong ? area.y + Math.round((area.height - height) / 2) : area.y + Math.round(area.height * 0.125);
  return { x, y, width, height };
}
function openNotice(payload) {
  const strong = payload.level === "strong";
  const win = new electron.BrowserWindow({
    ...boundsOf(payload.level),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    show: false,
    webPreferences
  });
  current = win;
  win.setAlwaysOnTop(true, strong ? "screen-saver" : "pop-up-menu");
  win.setVisibleOnAllWorkspaces(true);
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.webContents.send(CH.notify.show, payload);
    win.showInactive();
  });
  win.on("closed", () => {
    if (current === win) current = null;
    const next = queue.shift();
    if (next !== void 0) openNotice(next);
  });
  win.webContents.on("did-fail-load", (_event, code, description2, _url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error("[notify] 提醒页加载失败", code, description2);
    if (!win.isDestroyed()) win.destroy();
  });
  loadRenderer(win, "notify");
}
function showNotice(payload) {
  if (current !== null) {
    if (queue.length >= NOTICE_QUEUE_MAX) return;
    queue.push(payload);
    return;
  }
  openNotice(payload);
}
function clearQueuedNotice(reminderId) {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].reminderId === reminderId) queue.splice(i, 1);
  }
}
function closeAllNotices() {
  queue.length = 0;
  const win = current;
  current = null;
  if (win !== null && !win.isDestroyed()) win.destroy();
}
const MINUTE_MS = 6e4;
const REPEAT_HORIZON_DAYS = 30;
const REPEAT_REFILL_DAYS = 7;
function dailyClock(value) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (matched === null) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
function localInstant(day, hour, minute) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}
function planRepeatReminders(task, now) {
  const ruleText = task.repeatRule;
  let rule;
  try {
    rule = parseRepeatRule(ruleText);
  } catch {
    return [];
  }
  if (rule.unit === "D") return [];
  const clock = dailyClock(task.dailyTime);
  if (clock === null) return [];
  const today = toLocalDay(now);
  const anchor2 = task.activeFrom ?? toLocalDay(new Date(task.createdAt));
  const horizonEnd = addDays(today, REPEAT_HORIZON_DAYS);
  const last = task.activeTo !== null && task.activeTo < horizonEnd ? task.activeTo : horizonEnd;
  const lead = rule.unit === "W" ? [0] : rule.unit === "M" ? [-1, 0] : [-3, 0];
  const { hour, minute } = clock;
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (let day = today; day <= last; day = addDays(day, 1)) {
    if (!matchesRepeatDay(ruleText, day, anchor2)) continue;
    for (const offset of lead) {
      const fireDay = addDays(day, offset);
      if (fireDay < today) continue;
      if (task.activeTo !== null && fireDay > task.activeTo) continue;
      const at = localInstant(fireDay, hour, minute);
      const atMs = at.getTime();
      if (!Number.isFinite(atMs) || atMs <= now.getTime()) continue;
      if (seen.has(atMs)) continue;
      seen.add(atMs);
      result.push({ offsetMin: null, fireAt: at.toISOString(), level: "normal" });
    }
  }
  return result.sort((a, b) => a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0);
}
function planReminders(task, now) {
  if (task.status !== "todo" && task.status !== "doing") return [];
  if (task.type === "daily") return planRepeatReminders(task, now);
  if (task.dueAt === null || task.reminderOffsets.length === 0) return [];
  const due = dueInstant(task.dueAt);
  if (due === null) return [];
  const nowMs = now.getTime();
  const future = task.reminderOffsets.map((offsetMin) => ({ offsetMin, at: due.getTime() + offsetMin * MINUTE_MS })).filter((row2) => row2.at > nowMs).map((row2) => ({ offsetMin: row2.offsetMin, fireAt: new Date(row2.at).toISOString() })).sort((a, b) => a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0);
  const lastIndex = future.length - 1;
  return future.map((row2, index) => {
    const isLast = index === lastIndex;
    const level = task.type === "deadline" ? isLast ? "strong" : "normal" : isLast ? "normal" : "strong";
    return { offsetMin: row2.offsetMin, fireAt: row2.fireAt, level };
  });
}
const STALE_POPUP_MS = 10 * 6e4;
function isStale(fireAt, now) {
  const at = Date.parse(fireAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > STALE_POPUP_MS;
}
const FIRED_CHANNELS = ["inapp"];
function syncForTask(taskId) {
  const task = getTask(taskId);
  if (task === null) return [];
  const now = /* @__PURE__ */ new Date();
  if (task.type === "daily") {
    const repeat = parseRepeatRule(task.repeatRule);
    const rule = serializeRepeatRule(repeat);
    if (repeat.unit === "D") return replaceForTask(taskId, []);
    const clock = dailyClock(task.dailyTime);
    if (clock === null) return replaceForTask(taskId, []);
    const clockText = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    const repeatRows = planReminders(task, now).map((plan) => ({
      id: newId(),
      occurrenceId: null,
      offsetMin: null,
      fireAt: plan.fireAt,
      repeatRule: rule,
      channels: task.reminderChannels,
      level: "normal",
      status: "active",
      createdAt: now.toISOString()
    }));
    return ensureRepeatRows(taskId, rule, clockText, repeatRows);
  }
  const rows = planReminders(task, now).map((plan) => ({
    id: newId(),
    occurrenceId: null,
    offsetMin: plan.offsetMin,
    fireAt: plan.fireAt,
    repeatRule: null,
    channels: task.reminderChannels,
    level: plan.level,
    status: "active",
    createdAt: now.toISOString()
  }));
  return replaceForTask(taskId, rows);
}
function syncAll() {
  for (const task of listTasks({ status: ["todo", "doing"] })) {
    try {
      syncForTask(task.id);
    } catch (e) {
      console.warn("[reminder] 同步失败", task.id, e);
    }
  }
}
function ensureRepeatHorizon(now) {
  const boundary = now.getTime() + REPEAT_REFILL_DAYS * 864e5;
  for (const task of listTasks({ status: ["todo", "doing"] })) {
    if (task.type !== "daily") continue;
    try {
      const max = maxActiveAbsoluteFireAt(task.id);
      if (max === null || Date.parse(max) < boundary) syncForTask(task.id);
    } catch (e) {
      console.warn("[reminder] 重复任务补建失败", task.id, e);
    }
  }
}
function purgeInactiveTaskReminders() {
  return purgeForInactiveTasks();
}
function fireDue(now) {
  for (const reminder of listDue(now.toISOString())) {
    try {
      fireOne(reminder, !isStale(reminder.fireAt, now));
    } catch (e) {
      console.warn("[reminder] 触发失败", reminder.id, e);
    }
  }
}
function fireOne(reminder, fresh = true) {
  const now = /* @__PURE__ */ new Date();
  const task = reminder.taskId === null ? null : getTask(reminder.taskId);
  const meta = {
    kind: "reminder",
    reminderId: reminder.id,
    taskId: reminder.taskId,
    title: task === null ? "" : task.title,
    fireAt: reminder.fireAt,
    // 快照：原样抄 reminders.offset_min，不拿 fireAt - dueAt 现算（02 §3.1 的写入义务）
    offsetMin: reminder.offsetMin
  };
  const message = appendMessage({
    threadId: "main",
    role: "system",
    kind: "reminder",
    meta,
    linkedTaskId: reminder.taskId,
    // 提醒是任务通知，与发送模式无关（v0.73）
    mode: "task"
  });
  broadcast({ type: "message.appended", message });
  markFired$1(reminder.id, [...FIRED_CHANNELS], nowIso());
  if (!fresh) return;
  if (task === null) return;
  if (reminder.level === "strong") {
    try {
      recordAlert({ level: "strong", sourceId: reminder.id, title: task.title });
    } catch (e) {
      console.warn("[alert] 记录失败", e);
    }
    showMainWindow();
    return;
  }
  try {
    recordAlert({ level: "normal", sourceId: reminder.id, title: task.title });
  } catch (e) {
    console.warn("[alert] 记录失败", e);
  }
  showNotice(payloadOf(task, reminder, now));
}
function payloadOf(task, reminder, now) {
  return {
    level: reminder.level,
    title: task.title,
    // 重复任务没有 dueAt：两个标签留空，渲染层整块不渲染，不编造「还剩 / 截止」
    remainLabel: task.dueAt === null ? "" : fmtRemaining(task.dueAt, task.type, now),
    typeLabel: TYPE_LABEL[task.type],
    dueLabel: task.dueAt === null ? "" : fmtDueLabel(task.dueAt),
    reminderId: reminder.id
  };
}
const LHM_PORT = 8085;
const LHM_URL = `http://127.0.0.1:${LHM_PORT}/data.json`;
const CACHE_MS = 1500;
const MIN_TEMP = 1;
const MAX_TEMP = 125;
const LHM_TIMEOUT_MS = 1200;
const SMI_TIMEOUT_MS = 1500;
let cached = null;
let cachedAt = 0;
let lhmWarned = false;
let launchAttempted = false;
function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = node_http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}
const NUMBER_PATTERN = /-?\d+(?:[.,]\d+)?/;
function parseTemperature(value) {
  if (typeof value !== "string") return null;
  const match = NUMBER_PATTERN.exec(value);
  if (match === null) return null;
  const parsed = Number(match[0].replace(",", "."));
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < MIN_TEMP || rounded > MAX_TEMP) return null;
  return rounded;
}
function pickTemperatures(rawJson) {
  let root2;
  try {
    root2 = JSON.parse(rawJson);
  } catch {
    return { cpu: null, gpu: null };
  }
  let cpu = null;
  let gpu = null;
  let cpuSeen = false;
  let gpuSeen = false;
  const walk = (node) => {
    if (cpuSeen && gpuSeen) return;
    if (node === null || typeof node !== "object") return;
    const item = node;
    if (item.Type === "Temperature" && typeof item.SensorId === "string" && typeof item.Text === "string") {
      const sensorId = item.SensorId;
      if (!cpuSeen && item.Text === "CPU Package" && (sensorId.startsWith("/intelcpu/") || sensorId.startsWith("/amdcpu/"))) {
        cpuSeen = true;
        cpu = parseTemperature(item.Value);
      } else if (!gpuSeen && item.Text === "GPU Core" && sensorId.startsWith("/gpu-")) {
        gpuSeen = true;
        gpu = parseTemperature(item.Value);
      }
    }
    const children = item.Children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    }
  };
  walk(root2);
  return { cpu, gpu };
}
function readNvidiaSmi() {
  return new Promise((resolve) => {
    node_child_process.execFile(
      "nvidia-smi",
      ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: SMI_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
        if (first === void 0) {
          resolve(null);
          return;
        }
        const parsed = Number.parseInt(first.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < MIN_TEMP || parsed > MAX_TEMP) {
          resolve(null);
          return;
        }
        resolve(parsed);
      }
    );
  });
}
async function readSensors() {
  if (cached !== null && Date.now() - cachedAt < CACHE_MS) return cached;
  let cpu = null;
  let gpu = null;
  try {
    const picked = pickTemperatures(await fetchText(LHM_URL, LHM_TIMEOUT_MS));
    cpu = picked.cpu;
    gpu = picked.gpu;
    lhmWarned = false;
  } catch {
    if (!lhmWarned) {
      lhmWarned = true;
      console.warn("[sensor] LibreHardwareMonitor 读数不可用，CPU 温度暂缺");
    }
  }
  if (gpu === null) gpu = await readNvidiaSmi();
  cached = { cpu, gpu, at: (/* @__PURE__ */ new Date()).toISOString() };
  cachedAt = Date.now();
  return cached;
}
function resetCache() {
  cached = null;
  cachedAt = 0;
}
async function ensureLhmStarted() {
  if (launchAttempted) return;
  launchAttempted = true;
  const { app, shell } = await import("electron");
  if (!app.isPackaged) return;
  const exe = node_path.join(node_path.dirname(process.execPath), "lhm", "LibreHardwareMonitor.exe");
  if (!node_fs.existsSync(exe)) return;
  try {
    await fetchText(LHM_URL, LHM_TIMEOUT_MS);
    return;
  } catch {
  }
  try {
    const failure = await shell.openPath(exe);
    if (failure.length > 0) console.warn("[sensor] 拉起 LibreHardwareMonitor 失败:", failure);
  } catch (e) {
    console.warn("[sensor] 拉起 LibreHardwareMonitor 失败:", e);
  }
}
const OWNER = "cuda-re0";
const REPO = "personalmanager-taskloop";
const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const UA$1 = "taskloop-updater";
const chromiumFetch$1 = (input, init) => electron.net.fetch(input instanceof URL ? input.toString() : input, init);
function withFailure$1(err, failure) {
  const error = err instanceof Error ? err : new Error(String(err));
  Object.assign(error, { failure });
  return error;
}
async function fetchLatestRelease(fetchImpl = chromiumFetch$1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1e4);
  try {
    let res;
    try {
      res = await fetchImpl(RELEASES_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": UA$1 },
        signal: controller.signal
      });
    } catch (e) {
      throw withFailure$1(e, "network");
    }
    if (res.status === 404) throw withFailure$1(new Error("GitHub 返回 404"), "notfound");
    if (!res.ok) throw withFailure$1(new Error(`GitHub 返回 ${res.status}`), "http");
    const data = await res.json();
    if (typeof data?.tag_name !== "string") throw withFailure$1(new Error("Release 缺少 tag_name"), "shape");
    const version2 = data.tag_name.replace(/^[vV]/, "").trim();
    if (version2 === "") throw withFailure$1(new Error("Release 的 tag_name 为空"), "shape");
    if (!/^\d+\.\d+\.\d+$/.test(version2)) {
      throw withFailure$1(new Error("Release 的 tag_name 形状不对"), "shape");
    }
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const asset = assets.find(
      (item) => item !== null && typeof item === "object" && item.name === "payload.json"
    );
    const payloadUrl = asset?.browser_download_url;
    if (typeof payloadUrl !== "string" || payloadUrl.trim() === "") {
      throw withFailure$1(new Error("Release 里没有 payload.json"), "shape");
    }
    return { version: version2, payloadUrl: payloadUrl.trim() };
  } finally {
    clearTimeout(timer);
  }
}
const MAX_PAYLOAD_BYTES = 40 * 1024 * 1024;
async function downloadPayload(url, fetchImpl = chromiumFetch$1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6e4);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA$1 },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`下载载荷失败：${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
      controller.abort();
      throw new Error("下载载荷超过 40 MiB");
    }
    if (res.body === null) {
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new Error("下载载荷超过 40 MiB");
      }
      return text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAYLOAD_BYTES) {
        controller.abort();
        throw new Error("下载载荷超过 40 MiB");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}
const MAX_FILE_BYTES$1 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES$1 = 32 * 1024 * 1024;
const MAX_FILES$1 = 200;
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;
function isPlainObject$1(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertSafeKey(key) {
  if (key.length === 0) throw new Error("载荷里出现空文件名");
  if (key.includes("\\")) throw new Error(`载荷文件名含反斜杠：${key}`);
  if (key.startsWith("/") || /^[A-Za-z]:/.test(key)) {
    throw new Error(`载荷文件名是绝对路径：${key}`);
  }
  if (key.split("/").includes("..")) throw new Error(`载荷文件名含越界路径段：${key}`);
}
function base64Bytes(key, value) {
  if (value.length % 4 !== 0 || !BASE64_SHAPE.test(value)) {
    throw new Error(`更新包文件不是合法 base64：${key}`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = value.length / 4 * 3 - padding;
  if (bytes <= 0) throw new Error(`更新包文件内容为空：${key}`);
  if (bytes > MAX_FILE_BYTES$1) throw new Error(`更新包单文件超过 8 MiB：${key}`);
  return bytes;
}
function parsePayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("更新包不是合法 JSON");
  }
  if (!isPlainObject$1(parsed)) throw new Error("更新包格式不对");
  const version2 = parsed.version;
  if (typeof version2 !== "string" || version2.trim() === "") {
    throw new Error("更新包缺少版本号");
  }
  const rawFiles = parsed.files;
  if (!isPlainObject$1(rawFiles) || Object.keys(rawFiles).length === 0) {
    throw new Error("更新包里没有文件");
  }
  const entries = Object.entries(rawFiles);
  if (entries.length > MAX_FILES$1) throw new Error(`更新包文件数超过 ${MAX_FILES$1}`);
  const files = {};
  let total = 0;
  for (const [key, value] of entries) {
    assertSafeKey(key);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`更新包文件内容为空：${key}`);
    }
    total += base64Bytes(key, value);
    if (total > MAX_TOTAL_BYTES$1) throw new Error("更新包解压后超过 32 MiB");
    files[key] = value;
  }
  return { version: version2, files };
}
function writePayloadTree(payload, targetDir) {
  const root2 = node_path.resolve(targetDir);
  const prefix = root2 + node_path.sep;
  let written = 0;
  for (const [key, value] of Object.entries(payload.files)) {
    const target = node_path.resolve(root2, key);
    if (!target.startsWith(prefix)) {
      console.warn(`[update] 跳过越界文件：${key}`);
      continue;
    }
    node_fs.mkdirSync(node_path.dirname(target), { recursive: true });
    node_fs.writeFileSync(target, Buffer.from(value, "base64"));
    written += 1;
  }
  return written;
}
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UA = "taskloop-updater";
const TIMEOUT_MS = 2e4;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const TOTAL_BUDGET_MS = 5 * 60 * 1e3;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 200;
const REQUIRED_FILES$1 = [
  "main/index.js",
  "preload/index.js",
  "renderer/main/index.html",
  "renderer/hud/index.html",
  "renderer/notify/index.html"
];
const refOf = (ref) => ref === null ? "master" : ref;
function withFailure(err, failure) {
  const error = err instanceof Error ? err : new Error(String(err));
  Object.assign(error, { failure });
  return error;
}
function nonRetryable(err, failure) {
  const error = failure === void 0 ? err instanceof Error ? err : new Error(String(err)) : withFailure(err, failure);
  Object.assign(error, { retryable: false });
  return error;
}
const isRetryable = (err) => err?.retryable !== false;
const delay = (ms) => new Promise((resolve2) => {
  setTimeout(resolve2, ms);
});
async function withRetry(fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryable(e)) throw e;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = RETRY_DELAY_MS * attempt;
      console.warn(
        `[update] ${label} 第 ${attempt} 次失败，${wait}ms 后重试：${e instanceof Error ? e.message : String(e)}`
      );
      await delay(wait);
    }
  }
  throw lastError;
}
const chromiumFetch = (input, init) => electron.net.fetch(input instanceof URL ? input.toString() : input, init);
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertSafeRel(rel) {
  if (rel.length === 0) throw new Error("清单里出现空文件名");
  if (rel.includes("\\")) throw new Error(`清单文件名含反斜杠：${rel}`);
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`清单文件名是绝对路径：${rel}`);
  }
  if (rel.split("/").includes("..")) throw new Error(`清单文件名含越界路径段：${rel}`);
}
function parseRepoManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("清单不是合法 JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("清单必须是普通对象（非数组、非 null）");
  const version2 = parsed.version;
  if (typeof version2 !== "string") throw new Error("清单缺少 version 或不是字符串");
  if (!/^\d+\.\d+\.\d+$/.test(version2)) throw new Error(`清单 version 形状不对：${version2}`);
  const files = parsed.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("清单 files 为空或不是数组");
  if (files.length > MAX_FILES) throw new Error(`清单 files 超过 ${MAX_FILES} 个`);
  const seen = /* @__PURE__ */ new Set();
  for (const rel of files) {
    if (typeof rel !== "string") throw new Error("清单 files 里有非字符串元素");
    assertSafeRel(rel);
    if (seen.has(rel)) throw new Error(`清单 files 里有重复元素：${rel}`);
    seen.add(rel);
  }
  const missing = REQUIRED_FILES$1.filter((rel) => !seen.has(rel));
  if (missing.length > 0) throw new Error(`清单缺少关键文件：${missing.join("、")}`);
  return { version: version2, files };
}
async function fetchRepoHead(fetchImpl = chromiumFetch) {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetchImpl(`${API}/commits/master`, {
          headers: { "User-Agent": UA },
          signal: controller.signal
        });
      } catch (e) {
        throw withFailure(e, "network");
      }
      if (res.status === 404) {
        throw nonRetryable(new Error("仓库里没有 master 分支"), "notfound");
      }
      if (!res.ok) {
        const error = new Error(`GitHub API 返回 ${res.status}`);
        throw res.status < 500 ? nonRetryable(error, "http") : withFailure(error, "http");
      }
      let body;
      try {
        body = await res.json();
      } catch (e) {
        throw nonRetryable(e, "shape");
      }
      const sha = isPlainObject(body) ? body.sha : void 0;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw nonRetryable(new Error("commits/master 的 sha 缺失或形状不对"), "shape");
      }
      return sha;
    } finally {
      clearTimeout(timer);
    }
  }, "取 commit sha");
}
async function fetchRepoManifest(ref, fetchImpl = chromiumFetch) {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetchImpl(`${RAW}/${refOf(ref)}/out/manifest.json`, {
          headers: { "User-Agent": UA },
          signal: controller.signal
        });
      } catch (e) {
        throw withFailure(e, "network");
      }
      if (res.status === 404) {
        throw nonRetryable(new Error("仓库里没有 out/manifest.json"), "notfound");
      }
      if (!res.ok) {
        const error = new Error(`raw 返回 ${res.status}`);
        throw res.status < 500 ? nonRetryable(error, "http") : withFailure(error, "http");
      }
      try {
        const declared = Number(res.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
          throw new Error("清单超过 1 MiB");
        }
        const body = await res.text();
        if (Buffer.byteLength(body, "utf8") > MAX_MANIFEST_BYTES) {
          throw new Error("清单超过 1 MiB");
        }
        return parseRepoManifest(body);
      } catch (e) {
        throw nonRetryable(e, "shape");
      }
    } finally {
      clearTimeout(timer);
    }
  }, "取清单");
}
async function downloadRepoTree(manifest, stagingDir, ref, fetchImpl = chromiumFetch) {
  const base = `${RAW}/${refOf(ref)}`;
  const root2 = node_path.resolve(stagingDir);
  const outRoot = node_path.resolve(root2, "out");
  const prefix = outRoot + node_path.sep;
  const startedAt = Date.now();
  let total = 0;
  let written = 0;
  for (const rel of manifest.files) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
      throw new Error("仓库源下载超时：已用超过 5 分钟");
    }
    const body = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        let res;
        try {
          res = await fetchImpl(`${base}/out/${rel}`, {
            headers: { "User-Agent": UA },
            signal: controller.signal
          });
        } catch (e) {
          throw new Error(`下载 ${rel} 失败：${e instanceof Error ? e.message : String(e)}`);
        }
        if (!res.ok) {
          const error = new Error(`下载 ${rel} 失败：状态码 ${res.status}`);
          throw res.status < 500 ? nonRetryable(error) : error;
        }
        const declared = Number(res.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：单文件超过 8 MiB`));
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength === 0) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：内容为空`));
        }
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：单文件超过 8 MiB`));
        }
        total += bytes.byteLength;
        if (total > MAX_TOTAL_BYTES) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：总量超过 32 MiB`));
        }
        return bytes;
      } finally {
        clearTimeout(timer);
      }
    }, `下载 ${rel}`);
    const target = node_path.resolve(outRoot, rel);
    if (!target.startsWith(prefix)) {
      console.warn(`[update] 跳过越界文件：${rel}`);
      continue;
    }
    node_fs.mkdirSync(node_path.dirname(target), { recursive: true });
    node_fs.writeFileSync(target, body);
    written += 1;
  }
  const pkgFile = node_path.join(root2, "package.json");
  const pkgBody = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}/package.json`, {
        headers: { "User-Agent": UA },
        signal: controller.signal
      });
      if (!res.ok) {
        const error = new Error(`下载 package.json 失败：状态码 ${res.status}`);
        throw res.status < 500 ? nonRetryable(error) : error;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw nonRetryable(new Error("下载 package.json 失败：内容为空"));
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }, "取 package.json");
  node_fs.writeFileSync(pkgFile, pkgBody);
  let landed;
  try {
    landed = JSON.parse(node_fs.readFileSync(pkgFile, "utf8")).version;
  } catch (e) {
    throw new Error(`仓库 package.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (landed !== manifest.version) {
    throw nonRetryable(
      new Error(`仓库 package.json 版本 ${String(landed)} 与清单 ${manifest.version} 不一致`)
    );
  }
  return written;
}
let pending = null;
function stateFile() {
  return node_path.join(electron.app.getPath("userData"), "update-state.json");
}
function compareVersion(a, b) {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
function segmentsOf(version2) {
  return version2.split(".").map((part) => {
    const value = Number(part.trim());
    return Number.isFinite(value) ? value : 0;
  });
}
const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1e3;
function readState() {
  try {
    const parsed = JSON.parse(node_fs.readFileSync(stateFile(), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const raw = parsed;
    if (typeof raw.attemptedVersion === "string") {
      return { version: raw.attemptedVersion, at: null };
    }
    if (typeof raw.version !== "string") return null;
    return { version: raw.version, at: typeof raw.at === "string" ? raw.at : null };
  } catch {
    return null;
  }
}
function writeState(mark) {
  const file = stateFile();
  node_fs.mkdirSync(node_path.dirname(file), { recursive: true });
  const body = mark === null ? {} : { version: mark.version, at: mark.at };
  node_fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}
`, "utf8");
}
function markIsFresh(mark, latest2) {
  if (mark.version !== latest2) return false;
  if (mark.at === null) return false;
  const triedAt = Date.parse(mark.at);
  if (Number.isNaN(triedAt)) return false;
  return Date.now() - triedAt < ATTEMPT_TTL_MS;
}
async function checkUpdate(options = {}) {
  const current2 = electron.app.getVersion();
  let found;
  let ref = null;
  try {
    ref = await fetchRepoHead();
  } catch (e) {
    console.warn("[update] 取 commit sha 失败，降级用 master 分支", e);
  }
  try {
    const manifest = await fetchRepoManifest(ref);
    found = { source: "repo", version: manifest.version, manifest, ref };
  } catch (repoError) {
    console.warn("[update] 仓库源不可用，回退 Release", repoError);
    try {
      const release = await fetchLatestRelease();
      found = { source: "release", version: release.version, url: release.payloadUrl };
    } catch (e) {
      if (options.manual === true) {
        const failure = e.failure;
        const message = failure === "notfound" ? "检查更新失败：仓库还没有发布任何版本" : failure === "network" ? "检查更新失败：连不上 GitHub" : "检查更新失败：无法访问 GitHub";
        throw appError("UNKNOWN", message, {
          detail: e instanceof Error ? e.message : String(e)
        });
      }
      console.error("[update] 查询 GitHub 失败", e);
      return { current: current2, latest: null, hasUpdate: false, applying: false };
    }
  }
  const latest2 = found.version;
  const hasUpdate = compareVersion(latest2, current2) > 0;
  if (!hasUpdate) return { current: current2, latest: latest2, hasUpdate: false, applying: false };
  if (options.manual !== true) {
    const mark = readState();
    if (mark !== null && markIsFresh(mark, latest2)) {
      console.error(`[update] ${latest2} 上次已尝试过但版本未变，本次不再安装`);
      return { current: current2, latest: latest2, hasUpdate: true, applying: false };
    }
    if (mark !== null && mark.version === latest2) {
      console.warn(`[update] ${latest2} 的尝试标记已超 24 小时，允许重试`);
    }
  }
  try {
    writeState({ version: latest2, at: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (e) {
    console.error("[update] 写 update-state.json 失败，本次不安装", e);
    return { current: current2, latest: latest2, hasUpdate: true, applying: false };
  }
  pending = found;
  return { current: current2, latest: latest2, hasUpdate: true, applying: true };
}
function versionOf(pkgFile) {
  try {
    const parsed = JSON.parse(node_fs.readFileSync(pkgFile, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const version2 = parsed.version;
    return typeof version2 === "string" ? version2 : null;
  } catch {
    return null;
  }
}
function copyTree(from, to) {
  node_fs.mkdirSync(to, { recursive: true });
  for (const entry of node_fs.readdirSync(from, { withFileTypes: true })) {
    const src = node_path.join(from, entry.name);
    const dst = node_path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else node_fs.copyFileSync(src, dst);
  }
}
function clearStaging(staging) {
  try {
    node_fs.rmSync(staging, { recursive: true, force: true });
  } catch (e) {
    console.error("[update] 清暂存目录失败", e);
  }
}
const CRITICAL_IN_OUT = [
  "main/index.js",
  "preload/index.js",
  "renderer/main/index.html",
  "renderer/hud/index.html",
  "renderer/notify/index.html"
];
const REQUIRED_FILES = CRITICAL_IN_OUT.map((rel) => `out/${rel}`);
function missingCritical(root2, entries = REQUIRED_FILES) {
  const bad = [];
  for (const rel of entries) {
    try {
      const stat = node_fs.statSync(node_path.join(root2, rel));
      if (!stat.isFile() || stat.size === 0) bad.push(rel);
    } catch {
      bad.push(rel);
    }
  }
  return bad;
}
function isInstallIntact(resourcesApp, version2) {
  if (missingCritical(resourcesApp).length > 0) return false;
  return versionOf(node_path.join(resourcesApp, "package.json")) === version2;
}
function rollbackInstall(resourcesApp) {
  const outDir = node_path.join(resourcesApp, "out");
  const outBak = node_path.join(resourcesApp, "out.bak");
  const outFailed = node_path.join(resourcesApp, "out.failed");
  const pkg2 = node_path.join(resourcesApp, "package.json");
  const pkgBak = node_path.join(resourcesApp, "package.json.bak");
  if (!node_fs.existsSync(outBak) || missingCritical(outBak, CRITICAL_IN_OUT).length > 0) {
    console.error("[update] 回滚中止：out.bak 不可用，未改任何目录");
    return false;
  }
  if (!node_fs.existsSync(pkgBak)) {
    console.error("[update] 回滚中止：package.json.bak 不可用，未改任何目录");
    return false;
  }
  try {
    if (node_fs.existsSync(outFailed)) node_fs.rmSync(outFailed, { recursive: true, force: true });
    if (node_fs.existsSync(outDir)) node_fs.renameSync(outDir, outFailed);
    node_fs.renameSync(outBak, outDir);
    node_fs.copyFileSync(pkgBak, pkg2);
  } catch (e) {
    console.error("[update] 回滚改名/复制失败", e);
    return false;
  }
  if (missingCritical(outDir, CRITICAL_IN_OUT).length > 0) {
    console.error("[update] 回滚后关键资源仍不可读，恢复原状");
    try {
      if (node_fs.existsSync(outDir)) node_fs.renameSync(outDir, outBak);
      if (node_fs.existsSync(outFailed)) node_fs.renameSync(outFailed, outDir);
    } catch (e) {
      console.error("[update] 恢复原状失败", e);
    }
    return false;
  }
  return true;
}
function resetAttempted() {
  try {
    writeState(null);
  } catch (e) {
    console.error("[update] 清尝试标记失败", e);
  }
}
async function applyUpdate() {
  if (pending === null) return;
  const update2 = pending;
  const { version: version2 } = update2;
  pending = null;
  const currentVersion = electron.app.getVersion();
  const staging = node_path.join(electron.app.getPath("userData"), "update-staging");
  try {
    node_fs.rmSync(staging, { recursive: true, force: true });
    node_fs.mkdirSync(staging, { recursive: true });
    if (update2.source === "repo") {
      if (await downloadRepoTree(update2.manifest, staging, update2.ref) === 0) {
        throw new Error("仓库源没有可写入的文件");
      }
    } else {
      const payload = parsePayload(await downloadPayload(update2.url));
      if (payload.version !== version2) {
        console.error(`[update] 载荷版本 ${payload.version} 与 Release ${version2} 不一致`);
        clearStaging(staging);
        resetAttempted();
        return;
      }
      if (writePayloadTree(payload, staging) === 0) {
        throw new Error("载荷里没有可写入的文件");
      }
    }
  } catch (e) {
    console.error("[update] 下载或解包失败", e);
    clearStaging(staging);
    resetAttempted();
    return;
  }
  const resourcesApp = node_path.join(node_path.dirname(electron.app.getPath("exe")), "resources", "app");
  const source = staging;
  const outDir = node_path.join(resourcesApp, "out");
  const outBak = node_path.join(resourcesApp, "out.bak");
  const pkg2 = node_path.join(resourcesApp, "package.json");
  const pkgBak = node_path.join(resourcesApp, "package.json.bak");
  let allowQuit = false;
  const holdQuit = (event) => {
    if (!allowQuit) event.preventDefault();
  };
  electron.app.on("before-quit", holdQuit);
  let covered = false;
  try {
    for (const win of electron.BrowserWindow.getAllWindows()) win.destroy();
    if (node_fs.existsSync(outBak)) node_fs.rmSync(outBak, { recursive: true, force: true });
    if (node_fs.existsSync(outDir)) node_fs.renameSync(outDir, outBak);
    if (node_fs.existsSync(pkg2)) node_fs.copyFileSync(pkg2, pkgBak);
    copyTree(source, resourcesApp);
    const landed = versionOf(pkg2);
    const missing = missingCritical(resourcesApp);
    if (landed !== version2) {
      console.error(`[update] 覆盖后版本不是 ${version2}（实得 ${landed ?? "null"}），回滚`);
    } else if (missing.length > 0) {
      console.error(`[update] 覆盖后关键资源缺失：${missing.join("、")}，回滚`);
    } else {
      covered = true;
    }
  } catch (e) {
    console.error("[update] 覆盖失败，回滚", e);
  }
  const rolledBack = covered ? false : rollbackInstall(resourcesApp);
  const intact = covered || rolledBack ? false : isInstallIntact(resourcesApp, currentVersion);
  if (!covered && !rolledBack && !intact) {
    electron.app.off("before-quit", holdQuit);
    console.error("[update] 回滚失败，保留 out.failed / out.bak 供人工恢复；本次不重启");
    return;
  }
  if (intact) {
    console.warn(
      `[update] 回滚未完成，但旧版仍完好（关键资源齐全、版本 ${currentVersion}），按回滚成功处理`
    );
  }
  electron.app.off("before-quit", holdQuit);
  electron.app.relaunch();
  allowQuit = true;
  electron.app.quit();
}
async function runStartupUpdateCheck() {
  if (!electron.app.isPackaged) return;
  try {
    const result = await checkUpdate();
    if (result.applying) void applyUpdate();
  } catch (e) {
    console.error("[update] 启动自检失败", e);
  }
}
function toErrorEnvelope(e) {
  if (e instanceof AppErrorException) {
    return { ok: false, error: e.toAppError() };
  }
  const detail = e instanceof Error ? e.message : String(e);
  console.error("[ipc] 未捕获异常（UNKNOWN 兜底）", e instanceof Error ? e.stack : e);
  return {
    ok: false,
    error: { code: "UNKNOWN", message: "未知错误", detail, retryable: false }
  };
}
function runEnvelope(fn) {
  try {
    const data = fn();
    if (data instanceof Promise) {
      return data.then(
        (resolved) => ({ ok: true, data: resolved }),
        toErrorEnvelope
      );
    }
    return { ok: true, data };
  } catch (e) {
    return toErrorEnvelope(e);
  }
}
const INVALID_INPUT_MESSAGE = "请求参数格式不正确";
const taskStatusSchema = zod.z.enum([
  "todo",
  "doing",
  "pending_review",
  "reviewing",
  "done",
  "missed",
  "discarded",
  "archived"
]);
const taskTypeSchema = zod.z.enum(["daily", "deadline", "event"]);
const difficultySchema = zod.z.enum(["trivial", "easy", "medium", "hard", "epic"]);
const notifyChannelSchema = zod.z.enum(["inapp", "toast", "mail", "webhook"]);
const prioritySchema = zod.z.union([zod.z.literal(0), zod.z.literal(1), zod.z.literal(2)]);
const hudModeSchema = zod.z.enum(["ball", "panel"]);
const monthSchema = zod.z.number().int().min(1).max(12);
const yearSchema = zod.z.number().int();
const taskPatchSchema = zod.z.object({
  title: zod.z.string().optional(),
  detailMd: zod.z.string().optional(),
  priority: prioritySchema.optional(),
  difficulty: difficultySchema.optional(),
  estimateMin: zod.z.number().nullable().optional(),
  dueAt: zod.z.string().nullable().optional(),
  dailyTime: zod.z.string().nullable().optional(),
  repeatRule: zod.z.string().nullable().optional(),
  activeFrom: zod.z.string().nullable().optional(),
  activeTo: zod.z.string().nullable().optional(),
  reminderOffsets: zod.z.array(zod.z.number()).optional(),
  reminderChannels: zod.z.array(notifyChannelSchema).optional(),
  requiresEvidence: zod.z.boolean().optional(),
  tags: zod.z.array(zod.z.string()).optional()
});
const taskCreatePatchSchema = taskPatchSchema.extend({
  type: taskTypeSchema.optional()
});
const evidenceSchema = zod.z.union([
  zod.z.object({
    kind: zod.z.literal("text"),
    text: zod.z.string(),
    addedAt: zod.z.string()
  }),
  zod.z.object({
    kind: zod.z.literal("attachment"),
    attachmentId: zod.z.string(),
    addedAt: zod.z.string()
  })
]);
const idInput = { id: zod.z.string() };
const monthInput = { year: yearSchema, month: monthSchema };
const qualitySchema = zod.z.enum(["partial", "met", "exceeded"]);
const chatModeSchema = zod.z.enum(["chat", "task"]).default("chat");
const personaToneSchema = zod.z.enum(["warm", "plain", "playful"]);
const memoryKindSchema = zod.z.enum(["profile", "preference", "fact"]);
const memorySourceSchema = zod.z.enum(["auto", "manual"]);
const EVENT_RESULTS = ["exceeded", "met", "below"];
const eventResultSchema = zod.z.enum(EVENT_RESULTS);
const completeTaskSchema = zod.z.preprocess(
  (raw) => {
    if (raw !== null && typeof raw === "object") {
      const record = raw;
      if (record.noPoints === true && record.quality !== void 0) return void 0;
    }
    return raw;
  },
  zod.z.union([
    zod.z.object({
      id: zod.z.string(),
      quality: qualitySchema,
      // 仅 event 生效（v0.19）：deadline / daily 传了由 service 忽略，不报错
      result: eventResultSchema.optional(),
      evidence: zod.z.array(evidenceSchema).optional(),
      noPoints: zod.z.literal(false).optional()
    }),
    zod.z.object({
      id: zod.z.string(),
      noPoints: zod.z.literal(true),
      evidence: zod.z.array(evidenceSchema).optional()
    })
  ])
);
const HUD_BG_PATTERN = /^#[0-9a-fA-F]{6}$/;
const BASE_URL_MESSAGE = "接口地址必须是以 http:// 或 https:// 开头的完整地址";
const setSettingSchema = zod.z.object({ key: zod.z.string().min(1), value: zod.z.unknown() }).superRefine((input, ctx) => {
  const fail2 = (message) => {
    ctx.addIssue({ code: "custom", path: ["value"], message });
  };
  if (input.key === "hud.opacity") {
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) fail2("透明度必须是数字");
    return;
  }
  if (input.key === "hud.size") {
    if (input.value === null) return;
    const size = input.value;
    if (typeof size !== "object" || size === null || typeof size.width !== "number" || typeof size.height !== "number" || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
      fail2("面板尺寸必须是 {width,height}");
    }
    return;
  }
  if (input.key === "hud.background") {
    if (input.value === null) return;
    if (typeof input.value !== "string" || !HUD_BG_PATTERN.test(input.value)) {
      fail2("背景色必须是 #rrggbb");
    }
    return;
  }
  if (input.key === "ai.baseUrl") {
    if (typeof input.value !== "string" || input.value.trim().length === 0) {
      fail2(BASE_URL_MESSAGE);
      return;
    }
    const trimmed = input.value.trim();
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      fail2(BASE_URL_MESSAGE);
      return;
    }
    try {
      new URL(trimmed);
    } catch {
      fail2(BASE_URL_MESSAGE);
    }
    return;
  }
  if (input.key === "ai.chat.model") {
    if (typeof input.value !== "string" || input.value.trim().length === 0) {
      fail2("模型名不能为空");
    }
  }
}).transform((input) => {
  if (input.key === "hud.opacity") {
    return { ...input, value: clampOpacity(input.value) };
  }
  if (input.key === "hud.size" && input.value !== null) {
    return { ...input, value: clampSize(input.value) };
  }
  return input;
});
const g = {
  // app
  getBootstrap: zod.z.undefined(),
  setSetting: setSettingSchema,
  openExternal: zod.z.object({ url: zod.z.string() }),
  quit: zod.z.undefined(),
  // 无入参：纯粹的窗口动作（v0.46）
  showMain: zod.z.undefined(),
  // v0.60：无入参（preload 不带 payload，故 optional，与 aiHealth 同款）
  checkUpdate: zod.z.object({}).optional(),
  // task
  list: zod.z.object({
    status: zod.z.array(taskStatusSchema).optional(),
    includeSubtasks: zod.z.boolean().optional()
  }),
  get: zod.z.object(idInput),
  promoteDraft: zod.z.object({
    messageId: zod.z.string(),
    localId: zod.z.string(),
    // 创建侧 patch（v0.15）：含可选 type（草稿卡就地改类型 → 确认按新类型落库，02 §3.2）
    patch: taskCreatePatchSchema.optional()
  }),
  update: zod.z.object({ id: zod.z.string(), patch: taskPatchSchema }),
  transition: zod.z.object({
    id: zod.z.string(),
    to: taskStatusSchema,
    reason: zod.z.string().optional()
  }),
  addEvidence: zod.z.object({ id: zod.z.string(), evidence: evidenceSchema }),
  // v0.61：按数组下标删一条证据。越界由 service 判，schema 只挡住负号与小数
  removeEvidence: zod.z.object({ id: zod.z.string(), index: zod.z.number().int().min(0) }),
  setRequiresEvidence: zod.z.object({ id: zod.z.string(), value: zod.z.boolean() }),
  reorder: zod.z.object({ id: zod.z.string(), beforeId: zod.z.string().nullable() }),
  createManual: zod.z.object({
    type: taskTypeSchema,
    title: zod.z.string(),
    patch: taskPatchSchema.optional()
  }),
  remove: zod.z.object(idInput),
  setReminderOffsets: zod.z.object({
    id: zod.z.string(),
    offsets: zod.z.array(zod.z.number()),
    channels: zod.z.array(notifyChannelSchema).optional()
  }),
  // occurrence
  occurrenceToday: zod.z.undefined(),
  listByRange: zod.z.object({ from: zod.z.string(), to: zod.z.string() }),
  // task.complete（W6）
  taskComplete: completeTaskSchema,
  // task.undo（v0.19）：与 task.get 同款 idInput
  taskUndo: zod.z.object(idInput),
  // occurrence.complete / undo / skip（W6）
  occurrenceComplete: zod.z.object(idInput),
  occurrenceUndo: zod.z.object(idInput),
  occurrenceSkip: zod.z.object({ id: zod.z.string(), note: zod.z.string().optional() }),
  // calendar
  dayIndex: zod.z.object(monthInput),
  dayDetail: zod.z.object({ day: zod.z.string() }),
  // msg
  // limit 必须 ≥1：LIMIT 0 恒空、LIMIT -1 在 SQLite 里返回全表，都不该被当成合法分页
  msgList: zod.z.object({
    before: zod.z.string().optional(),
    limit: zod.z.number().int().min(1).optional()
  }),
  // msg.send / msg.retry（W4）：单条输入上限 4000 字、附件最多 4 张（03 §5）
  // v0.37：加 `mode`，省略按 'chat'；主进程不从文本推断模式
  // v0.49：`text` **故意不写 .min(1)**——只发图（空文本 + 附件）是设计内的消息，
  // 空文本的判定归 aiService（那里才给得出可读文案，守卫只有通用句）
  msgSend: zod.z.object({
    text: zod.z.string().max(4e3),
    attachmentIds: zod.z.array(zod.z.string()).max(4).optional(),
    mode: chatModeSchema
  }),
  msgRetry: zod.z.object({ messageId: zod.z.string().min(1) }),
  // v0.48：撤回/编辑共用同一条通道，形状与 msgRetry 一致
  msgRemove: zod.z.object({ messageId: zod.z.string().min(1) }),
  // ai.*（W4，02 §3.4）
  aiConfirmDraft: zod.z.object({ messageId: zod.z.string().min(1), localId: zod.z.string().min(1) }),
  aiRejectDrafts: zod.z.object({
    messageId: zod.z.string().min(1),
    localIds: zod.z.array(zod.z.string().min(1)).min(1)
  }),
  aiReview: zod.z.object({ taskId: zod.z.string().min(1), userText: zod.z.string().max(2e3).optional() }),
  // 无入参：preload 的 invoke(ch) 不带 payload，收到的是 undefined
  aiHealth: zod.z.object({}).optional(),
  // v0.44：无入参，与 quit / persona.get 同款
  keyStatus: zod.z.undefined(),
  // v0.47：只拦类型与长度上限，**不写 .min(1)**——空串的可读文案由 service 给
  setKey: zod.z.object({ key: zod.z.string().max(200) }),
  // 附件（v0.36）：`add` 只校验形状，白名单 mime 与大小上限仍归 attachmentService
  //（`sourcePath` / `base64` 二选一由服务判：两个都给以 sourcePath 为准，都不给抛 INVALID_INPUT）
  attachmentAdd: zod.z.object({
    name: zod.z.string(),
    mime: zod.z.string(),
    base64: zod.z.string().optional(),
    sourcePath: zod.z.string().optional()
  }),
  attachmentGet: zod.z.object(idInput),
  // 人物卡 / 记忆（v0.37）：**只拦类型与枚举，长度归 service**
  // ——02 §3.8 的长度错误有面向用户的原句（「助手名字最多 20 个字」），
  // 守卫拦出来的只有通用句「请求参数格式不正确」，会把可读的提示换掉。
  personaGet: zod.z.undefined(),
  personaUpdate: zod.z.object({
    name: zod.z.string().optional(),
    userCall: zod.z.string().optional(),
    personaMd: zod.z.string().optional(),
    tone: personaToneSchema.optional()
  }),
  memoryList: zod.z.object({ source: memorySourceSchema.optional() }).optional(),
  memoryAdd: zod.z.object({ contentMd: zod.z.string(), kind: memoryKindSchema }),
  memoryUpdate: zod.z.object({
    id: zod.z.string(),
    contentMd: zod.z.string().optional(),
    kind: memoryKindSchema.optional()
  }),
  memoryRemove: zod.z.object(idInput),
  // reminder（v0.58 · W8A）：接通五条，`testChannel` 仍留 NOT_WIRED
  // ——`limit` 与 msgList 同一条纪律（LIMIT 0 恒空、LIMIT -1 返回全表）
  reminderListByTask: zod.z.object({ taskId: zod.z.string().min(1) }),
  reminderListUpcoming: zod.z.object({ limit: zod.z.number().int().min(1).optional() }).optional(),
  reminderCancel: zod.z.object(idInput),
  // minutes 必须是正整数：0 或负数会让 fire_at 落在过去，下一轮 tick 立刻又弹一次
  reminderSnooze: zod.z.object({ id: zod.z.string().min(1), minutes: zod.z.number().int().positive() }),
  reminderSyncForTask: zod.z.object({ taskId: zod.z.string().min(1) }),
  // points
  balance: zod.z.undefined(),
  ledger: zod.z.object({
    from: zod.z.string().optional(),
    to: zod.z.string().optional(),
    limit: zod.z.number().int().min(1).optional()
  }),
  monthStats: zod.z.object(monthInput),
  adjust: zod.z.object({ delta: zod.z.number(), reason: zod.z.string() }),
  preview: zod.z.object({ type: taskTypeSchema, difficulty: difficultySchema }),
  streakPreview: zod.z.object({ current: zod.z.number(), nextDayWillReach: zod.z.number() }),
  // 零花钱（v0.45）：单笔上限**不放这里**——guard 失败只会返回「请求参数格式不正确」，
  // 而「单笔支出不能超过 1000 元」这句人话只有 service 层给得出来
  spend: zod.z.object({ amountCents: zod.z.number().int().positive(), note: zod.z.string().max(40).optional() }),
  spendUndo: zod.z.object({ entryId: zod.z.string().min(1) }),
  spendMonth: zod.z.undefined(),
  // hud（W9 · v0.30）：坐标必须有限值——NaN/Infinity 会让 setBounds 抛出，且会写进 hud.position
  hudSetMode: zod.z.object({ mode: hudModeSchema }),
  hudMoveTo: zod.z.object({ x: zod.z.number().finite(), y: zod.z.number().finite() }),
  // 长条拖动（v0.32）：绝对坐标同样必须是有限数——它会直接参与 setBounds
  hudDragTo: zod.z.object({ x: zod.z.number().finite(), y: zod.z.number().finite(), end: zod.z.boolean() }),
  hudDragBegin: zod.z.undefined(),
  hudSetVisible: zod.z.object({ visible: zod.z.boolean() }),
  hudGetState: zod.z.undefined(),
  // v0.62：无入参，与 hudGetState 同款（preload 的 invoke(ch) 不带 payload）
  hudSensors: zod.z.undefined(),
  // pulse（v0.86）：只管形状，标题长度 / 间隔范围 / 时刻格式全部归 pulseService
  pulseList: zod.z.undefined(),
  pulseCreate: zod.z.object({
    title: zod.z.string(),
    intervalMinutes: zod.z.number(),
    windowStart: zod.z.string().nullable().optional(),
    windowEnd: zod.z.string().nullable().optional()
  }),
  pulseSetEnabled: zod.z.object({ id: zod.z.string().min(1), enabled: zod.z.boolean() }),
  pulseRemove: zod.z.object({ id: zod.z.string().min(1) }),
  // alert（v0.88）：只校验 sourceId 非空，有没有匹配行由 repo 的 changes 说话
  alertAck: zod.z.object({ sourceId: zod.z.string().min(1) })
};
function parseInput(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw appError("INVALID_INPUT", INVALID_INPUT_MESSAGE, {
    detail: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
  });
}
const guards = {
  [CH.app.getBootstrap]: g.getBootstrap,
  [CH.app.setSetting]: g.setSetting,
  [CH.app.openExternal]: g.openExternal,
  [CH.app.quit]: g.quit,
  [CH.app.showMain]: g.showMain,
  [CH.app.checkUpdate]: g.checkUpdate,
  [CH.task.list]: g.list,
  [CH.task.get]: g.get,
  [CH.task.promoteDraft]: g.promoteDraft,
  [CH.task.update]: g.update,
  [CH.task.transition]: g.transition,
  [CH.task.addEvidence]: g.addEvidence,
  [CH.task.removeEvidence]: g.removeEvidence,
  [CH.task.setRequiresEvidence]: g.setRequiresEvidence,
  [CH.task.reorder]: g.reorder,
  [CH.task.createManual]: g.createManual,
  [CH.task.remove]: g.remove,
  [CH.task.setReminderOffsets]: g.setReminderOffsets,
  [CH.task.complete]: g.taskComplete,
  [CH.task.undo]: g.taskUndo,
  [CH.occurrence.today]: g.occurrenceToday,
  [CH.occurrence.listByRange]: g.listByRange,
  [CH.occurrence.complete]: g.occurrenceComplete,
  [CH.occurrence.undo]: g.occurrenceUndo,
  [CH.occurrence.skip]: g.occurrenceSkip,
  [CH.calendar.dayIndex]: g.dayIndex,
  [CH.calendar.dayDetail]: g.dayDetail,
  [CH.msg.list]: g.msgList,
  [CH.msg.send]: g.msgSend,
  [CH.msg.retry]: g.msgRetry,
  [CH.msg.remove]: g.msgRemove,
  [CH.ai.confirmDraft]: g.aiConfirmDraft,
  [CH.ai.rejectDrafts]: g.aiRejectDrafts,
  [CH.ai.review]: g.aiReview,
  [CH.ai.health]: g.aiHealth,
  [CH.ai.keyStatus]: g.keyStatus,
  [CH.ai.setKey]: g.setKey,
  [CH.attachment.add]: g.attachmentAdd,
  [CH.attachment.get]: g.attachmentGet,
  [CH.persona.get]: g.personaGet,
  [CH.persona.update]: g.personaUpdate,
  [CH.memory.list]: g.memoryList,
  [CH.memory.add]: g.memoryAdd,
  [CH.memory.update]: g.memoryUpdate,
  [CH.memory.remove]: g.memoryRemove,
  [CH.reminder.listByTask]: g.reminderListByTask,
  [CH.reminder.listUpcoming]: g.reminderListUpcoming,
  [CH.reminder.cancel]: g.reminderCancel,
  [CH.reminder.snooze]: g.reminderSnooze,
  [CH.reminder.syncForTask]: g.reminderSyncForTask,
  [CH.points.balance]: g.balance,
  [CH.points.ledger]: g.ledger,
  [CH.points.monthStats]: g.monthStats,
  [CH.points.adjust]: g.adjust,
  [CH.points.preview]: g.preview,
  [CH.points.streakPreview]: g.streakPreview,
  [CH.points.spend]: g.spend,
  [CH.points.spendUndo]: g.spendUndo,
  [CH.points.spendMonth]: g.spendMonth,
  [CH.hud.setMode]: g.hudSetMode,
  [CH.hud.moveTo]: g.hudMoveTo,
  [CH.hud.dragBegin]: g.hudDragBegin,
  [CH.hud.dragTo]: g.hudDragTo,
  [CH.hud.setVisible]: g.hudSetVisible,
  [CH.hud.getState]: g.hudGetState,
  [CH.hud.sensors]: g.hudSensors,
  [CH.pulse.list]: g.pulseList,
  [CH.pulse.create]: g.pulseCreate,
  [CH.pulse.setEnabled]: g.pulseSetEnabled,
  [CH.pulse.remove]: g.pulseRemove,
  [CH.alert.ack]: g.alertAck
};
const exitTimers = /* @__PURE__ */ new Set();
function clearExitTimers() {
  for (const timer of exitTimers) clearTimeout(timer);
  exitTimers.clear();
}
const NOT_WIRED = {
  // W4：AI 接入的六条已接通（msg.send / msg.retry / ai.*），不在表内
  // W8：提醒五条已随 v0.58 接通（listByTask / listUpcoming / cancel / snooze / syncForTask），
  // 只剩 testChannel 一条——外部渠道（mail / webhook）还没做，不能放个假 handler 假装能测
  [CH.reminder.testChannel]: { owner: "W8" },
  // W9：通知渠道 + 悬浮窗（悬浮窗五条已随 W9 接通，不在表内）
  [CH.channel.list]: { owner: "W9" },
  [CH.channel.setConfig]: { owner: "W9" },
  [CH.channel.setGlobal]: { owner: "W9" }
  // v0.36：attachment.add / attachment.get 已随 W7 接通，不在表内
};
function diffKeys(before, after) {
  return Object.keys(before).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  );
}
function diffOccurrences(before, after) {
  const known = new Set(before.map((o) => o.id));
  return after.filter((o) => !known.has(o.id));
}
function broadcastDayStats(day) {
  broadcast({ type: "daystats.changed", day: getDay(day) });
}
function row(channel, guard, fn) {
  return {
    channel,
    run: (input) => runEnvelope(() => fn(parseInput(guard, input)))
  };
}
const TABLE = [
  /* ---------------- app（6） ---------------- */
  // 返回的就是当前全量快照，**不广播**（02 §3.2b 的例外条款）
  row(CH.app.getBootstrap, g.getBootstrap, () => {
    const today = todayLocalDay();
    const [year, month] = today.split("-").map(Number);
    const { from, to } = monthBounds(year, month);
    return {
      tasks: listTasks({ status: ["todo", "doing", "pending_review", "reviewing"] }),
      todayOccurrences: listToday(),
      messages: recentMessages(BOOTSTRAP_MESSAGE_LIMIT),
      balance: balance(),
      today: todayStat(),
      monthIndex: dayIndex(from, to),
      recentLedger: recentLedger(20),
      settings: getAll(),
      // 通知渠道可用性恒空到 W8（02 §3.1），不许返回假的可用性
      channels: []
    };
  }),
  row(CH.app.setSetting, g.setSetting, (input) => {
    set(input.key, input.value);
    broadcast({ type: "app.setting.changed", key: input.key, value: input.value });
  }),
  row(CH.app.openExternal, g.openExternal, (input) => {
    let parsed;
    try {
      parsed = new URL(input.url);
    } catch {
      throw appError("INVALID_INPUT", "只允许打开 http/https 链接", { detail: input.url });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw appError("INVALID_INPUT", "只允许打开 http/https 链接", { detail: input.url });
    }
    void electron.shell.openExternal(parsed.toString()).catch((e) => {
      console.error("[ipc] openExternal 失败", parsed.toString(), e);
    });
  }),
  // v0.46：无入参、无返回值、不广播、不落库，纯粹的窗口动作
  row(CH.app.showMain, g.showMain, () => {
    showMainWindow();
  }),
  row(CH.app.quit, g.quit, () => {
    electron.app.quit();
    exitTimers.add(setTimeout(() => electron.app.exit(0), 800));
  }),
  // v0.60：手动更新检查。`applying` 为真时**不在这里**立刻重启——留 2 秒让渲染层
  // 把「正在更新」画出来，否则按钮状态永远是上一次的
  row(CH.app.checkUpdate, g.checkUpdate, async () => {
    const result = await checkUpdate({ manual: true });
    if (result.applying) exitTimers.add(setTimeout(() => {
      void applyUpdate();
    }, 2e3));
    return result;
  }),
  /* ---------------- task（12） ---------------- */
  row(CH.task.list, g.list, (input) => listTasks(input)),
  row(CH.task.get, g.get, (input) => {
    return getTaskWithSubtasks(input.id);
  }),
  row(CH.task.promoteDraft, g.promoteDraft, (input) => {
    const today = todayLocalDay();
    const rangeTo = addDays(today, 3);
    const before = listRangeRaw(today, rangeTo);
    const { task, created } = promoteDraft(input);
    if (!created) return task;
    const createdOccurrences = diffOccurrences(
      before,
      listRangeRaw(today, rangeTo)
    ).filter((o) => o.day === today);
    broadcast({ type: "task.created", task });
    for (const sub of listTasks({ parentId: task.id })) {
      broadcast({ type: "task.created", task: sub });
    }
    if (createdOccurrences.length > 0) {
      broadcast({ type: "occurrence.created", occurrences: createdOccurrences });
    }
    const message = requireMessage(input.messageId);
    broadcast({ type: "message.patch", messageId: input.messageId, patch: { meta: message.meta } });
    broadcast({ type: "daystats.changed", day: getDay(today) });
    syncForTask(task.id);
    return task;
  }),
  row(CH.task.update, g.update, (input) => {
    const before = getTask(input.id);
    const after = updateTask(input.id, input.patch);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
    syncForTask(after.id);
    return after;
  }),
  row(CH.task.transition, g.transition, (input) => {
    const before = getTask(input.id);
    const after = transitionTask(input.id, input.to);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
    syncForTask(after.id);
    return after;
  }),
  /* ---------------- task.complete（1，W6） ---------------- */
  row(CH.task.complete, g.taskComplete, (input) => {
    const before = getTask(input.id);
    const { task, entry } = completeTask(input);
    broadcast({
      type: "task.updated",
      task,
      changed: before ? diffKeys(before, task) : []
    });
    broadcast({
      type: "points.changed",
      balance: balance(),
      entry,
      today: todayStat()
    });
    broadcastDayStats(todayLocalDay());
    syncForTask(task.id);
    return { task, entry };
  }),
  /* ---------------- task.undo（1，v0.19） ---------------- */
  row(CH.task.undo, g.taskUndo, (input) => {
    const before = getTask(input.id);
    const { task, entry } = undoCompletion(input.id);
    if (before === null || before.status !== "done") return { task, entry };
    broadcast({ type: "task.updated", task, changed: diffKeys(before, task) });
    broadcast({
      type: "points.changed",
      balance: balance(),
      entry,
      today: todayStat()
    });
    const doneDay = before.completedAt === null ? null : isoToLocalDay(before.completedAt);
    if (doneDay !== null) broadcastDayStats(doneDay);
    if (doneDay !== todayLocalDay()) broadcastDayStats(todayLocalDay());
    syncForTask(task.id);
    return { task, entry };
  }),
  row(CH.task.addEvidence, g.addEvidence, (input) => {
    const before = getTask(input.id);
    const after = addEvidence(input.id, input.evidence);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
    return after;
  }),
  row(CH.task.removeEvidence, g.removeEvidence, (input) => {
    const before = getTask(input.id);
    const after = removeEvidence(input.id, input.index);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
    return after;
  }),
  row(CH.task.setRequiresEvidence, g.setRequiresEvidence, (input) => {
    const before = getTask(input.id);
    const after = setRequiresEvidence(input.id, input.value);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
    return after;
  }),
  row(CH.task.reorder, g.reorder, (input) => {
    const before = getTask(input.id);
    reorderTask(input.id, input.beforeId);
    const after = requireTask(input.id);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
  }),
  row(CH.task.createManual, g.createManual, (input) => {
    const { task, createdOccurrences } = createManualTask({
      type: input.type,
      title: input.title,
      ...input.patch
    });
    broadcast({ type: "task.created", task });
    if (createdOccurrences.length > 0) {
      broadcast({ type: "occurrence.created", occurrences: createdOccurrences });
    }
    broadcast({ type: "daystats.changed", day: getDay(todayLocalDay()) });
    syncForTask(task.id);
    return task;
  }),
  row(CH.task.remove, g.remove, (input) => {
    removeTask(input.id);
    broadcast({ type: "task.removed", taskId: input.id });
  }),
  row(CH.task.setReminderOffsets, g.setReminderOffsets, (input) => {
    const before = getTask(input.id);
    const after = setReminderOffsets(input.id, input.offsets, input.channels);
    broadcast({
      type: "task.updated",
      task: after,
      changed: before ? diffKeys(before, after) : []
    });
    return after;
  }),
  /* ---------------- occurrence（2，会写库的“读”） ---------------- */
  row(CH.occurrence.today, g.occurrenceToday, () => {
    const today = todayLocalDay();
    const before = listRangeRaw(today, today);
    const list2 = listToday();
    const created = diffOccurrences(before, list2);
    if (created.length > 0) broadcast({ type: "occurrence.created", occurrences: created });
    return list2;
  }),
  row(CH.occurrence.listByRange, g.listByRange, (input) => {
    const before = listRangeRaw(input.from, input.to);
    const list2 = listRange(input.from, input.to);
    const created = diffOccurrences(before, list2);
    if (created.length > 0) broadcast({ type: "occurrence.created", occurrences: created });
    return list2;
  }),
  /* ---------------- occurrence.complete / undo / skip（3，W6） ---------------- */
  row(CH.occurrence.complete, g.occurrenceComplete, (input) => {
    const { occurrence, entry, streakAfter, taskBefore, task } = awardOccurrence(
      input.id
    );
    broadcast({ type: "occurrence.updated", occurrence });
    broadcast({ type: "task.updated", task, changed: diffKeys(taskBefore, task) });
    broadcast({
      type: "points.changed",
      balance: balance(),
      entry,
      today: todayStat()
    });
    broadcastDayStats(occurrence.day);
    return { occurrence, entry, streakAfter };
  }),
  row(CH.occurrence.undo, g.occurrenceUndo, (input) => {
    const { occurrence, balanceAfter, taskBefore, task } = undoOccurrence(input.id);
    broadcast({ type: "occurrence.updated", occurrence });
    broadcast({ type: "task.updated", task, changed: diffKeys(taskBefore, task) });
    broadcast({
      type: "points.changed",
      balance: balanceAfter,
      entry: null,
      today: todayStat()
    });
    broadcastDayStats(occurrence.day);
    const today = todayLocalDay();
    if (occurrence.day !== today) broadcastDayStats(today);
    return { occurrence, balanceAfter };
  }),
  row(CH.occurrence.skip, g.occurrenceSkip, (input) => {
    const occurrence = skipOccurrence(input.id, input.note);
    if (occurrence.status === "skipped") {
      broadcast({ type: "occurrence.updated", occurrence });
    }
    return occurrence;
  }),
  /* ---------------- calendar（2） ---------------- */
  row(CH.calendar.dayIndex, g.dayIndex, (input) => {
    const { from, to } = monthBounds(input.year, input.month);
    return dayIndex(from, to);
  }),
  row(CH.calendar.dayDetail, g.dayDetail, (input) => dayDetail(input.day)),
  /* ---------------- msg（1） ---------------- */
  row(CH.msg.list, g.msgList, (input) => listMessages(input)),
  /* ---------------- msg.send / msg.retry / msg.remove（3） ---------------- */
  // send 秒返回：AI 那段是 aiService 内部的 void runTurn()，这里不 await（03 §3.1、02 §3.3）
  row(CH.msg.send, g.msgSend, (input) => send(input)),
  row(CH.msg.retry, g.msgRetry, (input) => retry(input)),
  // v0.48：撤回/编辑——按轮切片删消息，草稿卡已确认的任务一并软删
  row(CH.msg.remove, g.msgRemove, (input) => removeTurn(input)),
  /* ---------------- ai（6：W4 四条 + v0.44 keyStatus + v0.47 setKey） ---------------- */
  row(CH.ai.confirmDraft, g.aiConfirmDraft, (input) => confirmDraft(input)),
  row(CH.ai.rejectDrafts, g.aiRejectDrafts, (input) => rejectDrafts(input)),
  row(CH.ai.review, g.aiReview, (input) => review(input)),
  row(CH.ai.health, g.aiHealth, () => health()),
  // 设置抽屉只显示一行状态：走 keyStatus 而不是 health——后者会 await 一次多模态探测
  row(CH.ai.keyStatus, g.keyStatus, () => keyStatus()),
  // v0.47：唯一副作用是写文件，不广播、不落库、不发网络请求
  row(CH.ai.setKey, g.setKey, (input) => setKey(input.key)),
  /* ---------------- points（6） ---------------- */
  row(CH.points.balance, g.balance, () => balance()),
  row(CH.points.ledger, g.ledger, (input) => listLedger(input)),
  row(
    CH.points.monthStats,
    g.monthStats,
    (input) => monthStats(input.year, input.month)
  ),
  row(CH.points.adjust, g.adjust, (input) => {
    const entry = adjust(input.delta, input.reason);
    broadcast({
      type: "points.changed",
      balance: balance(),
      entry,
      today: todayStat()
    });
    return entry;
  }),
  // 纯计算，无副作用
  row(
    CH.points.preview,
    g.preview,
    (input) => previewPoints(input.type, input.difficulty)
  ),
  // 入参里的 current 不参与计算（奖励只由 nextDayWillReach 决定），透传仅为契约形状
  row(
    CH.points.streakPreview,
    g.streakPreview,
    (input) => streakBonusAt(input.nextDayWillReach)
  ),
  /* ---------------- 零花钱（3，v0.45 · W13） ---------------- */
  // 支出改余额与今日聚合，两条写入都推 `points.changed`（与 points.adjust 同一口径）；
  // `spendMonth` 是纯读，不广播。撤销时冲销行落在今天，balance 必须在广播前重新算。
  row(CH.points.spend, g.spend, (input) => {
    const entry = spend(input);
    broadcast({
      type: "points.changed",
      balance: balance(),
      entry,
      today: todayStat()
    });
    return entry;
  }),
  row(CH.points.spendUndo, g.spendUndo, (input) => {
    const entry = spendUndo(input.entryId);
    broadcast({
      type: "points.changed",
      balance: balance(),
      entry,
      today: todayStat()
    });
    return entry;
  }),
  row(CH.points.spendMonth, g.spendMonth, () => spendMonth()),
  /* ---------------- hud（7：W9 四条 + v0.32 dragBegin / dragTo + v0.62 sensors） ---------------- */
  // 状态与坐标全在 hudService：handler 只做入参校验 + 转发，不在这里算 bounds。
  // setMode 的 `hud.mode.changed` 广播也在 hudService 里（同一处改动同一个广播，避免漏发）。
  row(CH.hud.setMode, g.hudSetMode, (input) => setMode(input.mode)),
  row(CH.hud.moveTo, g.hudMoveTo, (input) => moveTo(input.x, input.y)),
  // 长条长按拖动（v0.32）：渲染层先取左上角算抓取偏移，之后只发绝对坐标
  row(CH.hud.dragBegin, g.hudDragBegin, () => dragBegin()),
  row(
    CH.hud.dragTo,
    g.hudDragTo,
    (input) => dragTo(input.x, input.y, input.end)
  ),
  row(CH.hud.setVisible, g.hudSetVisible, (input) => setVisible(input.visible)),
  row(CH.hud.getState, g.hudGetState, () => getState()),
  // v0.62：温度现取现回，缓存与失败兜底都在 sensorService，这里不判断值
  row(CH.hud.sensors, g.hudSensors, () => readSensors()),
  /* ---------------- attachment（2，v0.36 · W7 证据） ---------------- */
  // 附件没有域事件：加完只回 Attachment，审核卡靠动作返回后重取任务拿到新证据。
  // 校验（mime 白名单、体积上限）全在 attachmentService，这里不重复。
  row(CH.attachment.add, g.attachmentAdd, (input) => add(input)),
  row(CH.attachment.get, g.attachmentGet, (input) => {
    const found = attachmentById(input.id);
    if (found === null) throw appError("NOT_FOUND", "附件不存在", { detail: input.id });
    return found;
  }),
  /* ---------------- persona / memory（6，v0.37 · W12） ---------------- */
  // 六条都**不广播域事件**：Persona 不是 settings，改动下一轮聊天自然生效（02 §3.8）；
  // 记忆没有跨窗口消费者，界面入口要等 W12B。
  row(CH.persona.get, g.personaGet, () => get$1()),
  row(CH.persona.update, g.personaUpdate, (input) => update(input)),
  row(CH.memory.list, g.memoryList, (input) => list$2(input ?? {})),
  row(CH.memory.add, g.memoryAdd, (input) => addManual(input)),
  row(
    CH.memory.update,
    g.memoryUpdate,
    (input) => update$2(input.id, { contentMd: input.contentMd, kind: input.kind })
  ),
  row(CH.memory.remove, g.memoryRemove, (input) => remove$2(input.id)),
  /* ---------------- reminder（5，v0.58 · W8A） ---------------- */
  // 五条都是薄转发：重建 / 查询 / 取消 / 稍后 / 手动同步。本单只有站内渠道，
  // `reminder.testChannel` 因此仍留在 NOT_WIRED（外部渠道没做，不放假 handler）。
  row(
    CH.reminder.listByTask,
    g.reminderListByTask,
    (input) => listByTask(input.taskId)
  ),
  row(
    CH.reminder.listUpcoming,
    g.reminderListUpcoming,
    (input) => listUpcoming(input?.limit)
  ),
  row(CH.reminder.cancel, g.reminderCancel, (input) => {
    cancel(input.id);
  }),
  row(CH.reminder.snooze, g.reminderSnooze, (input) => {
    const fireAt = new Date(Date.now() + input.minutes * 6e4).toISOString();
    const updated = snooze(input.id, fireAt);
    clearQueuedNotice(input.id);
    return updated;
  }),
  row(
    CH.reminder.syncForTask,
    g.reminderSyncForTask,
    (input) => syncForTask(input.taskId)
  ),
  /* ---------------- pulse（4，v0.86） ---------------- */
  // 四条薄转发：不广播域事件，提醒本身不进会话区、不进积分/日历
  row(CH.pulse.list, g.pulseList, () => list()),
  row(CH.pulse.create, g.pulseCreate, (input) => create(input)),
  row(
    CH.pulse.setEnabled,
    g.pulseSetEnabled,
    (input) => setEnabled(input.id, input.enabled)
  ),
  row(CH.pulse.remove, g.pulseRemove, (input) => {
    remove(input.id);
    return { removed: true };
  }),
  /* ---------------- alert（1，v0.88） ---------------- */
  // 只翻 acked_at：没有匹配行返回 0，不当错误
  row(CH.alert.ack, g.alertAck, (input) => ({ acked: ackAlert(input.sourceId) }))
];
const WIRED_CHANNELS = TABLE.map((r) => r.channel);
function createHandlers(ipc) {
  const wired = /* @__PURE__ */ new Map();
  for (const r of TABLE) {
    if (wired.has(r.channel)) {
      throw new Error(`通道重复注册: ${r.channel}`);
    }
    wired.set(r.channel, r.run);
    ipc.handle(r.channel, (_event, input) => r.run(input));
  }
  return wired;
}
function registerIpcHandlers() {
  createHandlers(electron.ipcMain);
}
const name = "taskloop";
const version = "0.91.2";
const description = "taskloop desktop shell";
const main = "./out/main/index.js";
const author = "";
const license = "UNLICENSED";
const scripts = {
  dev: "electron-vite dev",
  build: "npm run typecheck && electron-vite build && node scripts/make-manifest.mjs",
  start: "electron-vite preview",
  typecheck: "tsc --noEmit --composite false -p tsconfig.node.json && tsc --noEmit --composite false -p tsconfig.web.json && tsc --noEmit --composite false -p tsconfig.test.json",
  lint: "eslint . --ext .ts,.tsx --max-warnings 0",
  test: "node scripts/test.mjs",
  pack: "node scripts/pack.mjs",
  release: "npm run build && npm run pack && node scripts/make-payload.mjs",
  format: 'prettier --write "src/**/*.{ts,tsx,html}" "*.{ts,json,cjs}"',
  rebuild: "electron-rebuild -f -w better-sqlite3",
  postinstall: "electron-rebuild -f -w better-sqlite3"
};
const dependencies = {
  "better-sqlite3": "11.10.0",
  react: "18.3.1",
  "react-dom": "18.3.1",
  zod: "^4.6.7"
};
const devDependencies = {
  "@electron/rebuild": "3.7.1",
  "@types/better-sqlite3": "7.6.12",
  "@types/node": "22.10.2",
  "@types/react": "18.3.12",
  "@types/react-dom": "18.3.1",
  "@typescript-eslint/eslint-plugin": "8.18.0",
  "@typescript-eslint/parser": "8.18.0",
  "@vitejs/plugin-react": "4.3.4",
  electron: "33.4.11",
  "electron-vite": "2.3.0",
  eslint: "8.57.1",
  "eslint-config-prettier": "9.1.0",
  prettier: "3.4.2",
  typescript: "5.6.3",
  vite: "5.4.11",
  vitest: "^2.1.8"
};
const pkg = {
  name,
  version,
  "private": true,
  description,
  main,
  author,
  license,
  scripts,
  dependencies,
  devDependencies
};
function readOrCreateToken() {
  try {
    const file = node_path.join(electron.app.getPath("userData"), "mcp-token.txt");
    try {
      const existing = node_fs.readFileSync(file, "utf8").trim();
      if (existing.length > 0) return existing;
    } catch {
    }
    const token = node_crypto.randomBytes(16).toString("hex");
    node_fs.writeFileSync(file, token, { encoding: "utf8", mode: 384 });
    return token;
  } catch {
    return null;
  }
}
function compareTasks(a, b) {
  const rank = (t) => t.status === "doing" ? 0 : 1;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.priority !== b.priority) return b.priority - a.priority;
  const at = dueInstant(a.dueAt);
  const bt = dueInstant(b.dueAt);
  if (at === null || bt === null) {
    if (at === null && bt === null) return a.sortKey - b.sortKey;
    return at === null ? 1 : -1;
  }
  if (at.getTime() !== bt.getTime()) return at.getTime() - bt.getTime();
  return a.sortKey - b.sortKey;
}
function isDoneToday(task, today) {
  return task.status === "done" && task.completedAt !== null && toLocalDay(new Date(task.completedAt)) === today;
}
function isMissedToday(task, today) {
  return task.status === "missed" && toLocalDay(new Date(task.updatedAt)) === today;
}
function groupTasks(tasks, occurrences, today = toLocalDay(/* @__PURE__ */ new Date())) {
  const byId2 = new Map(tasks.map((t) => [t.id, t]));
  const daily = occurrences.filter((o) => o.day === today && (o.status === "pending" || o.status === "done")).map((o) => ({ occurrence: o, task: byId2.get(o.taskId) ?? null })).sort((a, b) => {
    const rank = (r) => r.occurrence.status === "pending" ? 0 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.task?.sortKey ?? 0) - (b.task?.sortKey ?? 0);
  });
  const topLevel = tasks.filter((t) => t.parentId === null);
  const byType = (type) => [
    ...topLevel.filter((t) => t.type === type && t.status !== "done" && t.status !== "missed").sort(compareTasks),
    ...topLevel.filter((t) => t.type === type && (isDoneToday(t, today) || isMissedToday(t, today))).sort(compareTasks)
  ];
  return {
    daily,
    deadline: byType("deadline"),
    event: byType("event")
  };
}
function remainingLabel(task, now) {
  return fmtRemaining(task.dueAt, task.type, now);
}
function dueEditKindOf(dueAt) {
  const precision = duePrecisionOf(dueAt);
  if (precision === "minute") return "minute";
  if (precision === "day") return "day";
  return null;
}
function dueDateValueOf(dueAt) {
  const precision = duePrecisionOf(dueAt);
  if (precision === "minute") return toDatetimeLocal(dueAt).slice(0, 10);
  if (precision === "day") return dueAt.slice(0, 10);
  return "";
}
function dueTimeValueOf(dueAt) {
  if (duePrecisionOf(dueAt) !== "minute") return "";
  return toDatetimeLocal(dueAt).slice(11, 16);
}
function duePatchOfParts(date, time) {
  if (date === "") return "";
  if (time === "") return date;
  return (/* @__PURE__ */ new Date(`${date}T${time}`)).toISOString();
}
function canEditDueOf(task) {
  if (task.type !== "event" && task.type !== "deadline") return false;
  if (task.status !== "todo" && task.status !== "doing") return false;
  return dueEditKindOf(task.dueAt) !== null;
}
function taskRightParts(task, now) {
  if (task.status === "done" || task.status === "missed") return { remaining: "", due: "" };
  return { remaining: remainingLabel(task, now), due: fmtDueLabel(task.dueAt) };
}
function taskRightLabel(task, now) {
  const { remaining, due } = taskRightParts(task, now);
  if (remaining === "" && due === "") return "";
  if (remaining === "") return due;
  if (due === "") return remaining;
  return `${remaining} · ${due}`;
}
function isStepChecked(step) {
  return step.status !== "todo";
}
const ALL_STATUSES = [
  "todo",
  "doing",
  "pending_review",
  "reviewing",
  "done",
  "missed",
  "discarded",
  "archived"
];
const MCP_TOOLS = [
  {
    name: "get_overview",
    description: "今日概览：待办数、今日打卡数、今日/本周/本月积分",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_tasks",
    description: "任务列表（不含详情正文）",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["active", "today", "all"] },
        limit: { type: "number", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_task",
    description: "任务详情（含正文与子步骤）",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "list_messages",
    description: "聊天文本消息",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_points",
    description: "积分流水汇总",
    inputSchema: {
      type: "object",
      properties: { range: { type: "string", enum: ["today", "week", "month"] } },
      additionalProperties: false
    }
  },
  {
    name: "list_alerts",
    description: "列出最近提醒及其确认状态；acked=false 且 escalated=true 表示用户没理会",
    inputSchema: {
      type: "object",
      properties: { sinceMinutes: { type: "number", minimum: 1, maximum: 1440 } },
      additionalProperties: false
    }
  }
];
function localIsoNow() {
  const now = /* @__PURE__ */ new Date();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const wall = new Date(now.getTime() + offsetMin * 6e4).toISOString();
  return `${wall.slice(0, -1)}${sign}${hh}:${mm}`;
}
function limitOf(raw, fallback) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(raw)));
}
function scopeOf(raw) {
  if (raw === void 0 || raw === "active") return "active";
  if (raw === "today" || raw === "all") return raw;
  throw new Error("scope 只能是 active、today 或 all");
}
function rangeArgOf(raw) {
  if (raw === void 0 || raw === "today") return "today";
  if (raw === "week" || raw === "month") return raw;
  throw new Error("range 只能是 today、week 或 month");
}
function requireId(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("任务 id 不能为空");
  return raw;
}
function rangeOf(kind) {
  const today = todayLocalDay();
  if (kind === "today") return { from: today, to: today };
  if (kind === "week") return { from: addDays(today, 1 - isoWeekday$1(today)), to: today };
  const [year, month] = today.split("-").map(Number);
  return { from: monthBounds(year, month).from, to: today };
}
function pointsInRange(range) {
  const total = daysBetweenInclusive(range.from, range.to).reduce(
    (sum, day) => sum + dayStatOf(day).points,
    0
  );
  return roundPoints(total);
}
function stepsByParent() {
  const all = listTasks({ status: ALL_STATUSES, includeSubtasks: true });
  const map = /* @__PURE__ */ new Map();
  for (const task of all) {
    if (task.parentId === null) continue;
    const stat = map.get(task.parentId) ?? { done: 0, total: 0 };
    stat.total += 1;
    if (task.status === "done") stat.done += 1;
    map.set(task.parentId, stat);
  }
  return map;
}
function getOverview() {
  const today = todayLocalDay();
  const pendingTasks = listTasks({ status: ALL_STATUSES }).filter(
    (task) => task.status !== "done" && task.status !== "missed" && task.status !== "discarded" && task.status !== "archived"
  ).length;
  return {
    now: localIsoNow(),
    today,
    pendingTasks,
    todayOccurrences: listRangeRaw(today, today).length,
    points: {
      today: pointsInRange(rangeOf("today")),
      week: pointsInRange(rangeOf("week")),
      month: pointsInRange(rangeOf("month"))
    }
  };
}
function listTasksTool(args) {
  const scope = scopeOf(args.scope);
  const limit = limitOf(args.limit, 50);
  const all = listTasks({ status: ALL_STATUSES });
  let picked;
  if (scope === "today") {
    const ids = new Set(
      listRangeRaw(todayLocalDay(), todayLocalDay()).map((o) => o.taskId)
    );
    picked = all.filter((task) => ids.has(task.id));
  } else if (scope === "all") {
    picked = all;
  } else {
    picked = all.filter(
      (task) => task.status !== "done" && task.status !== "missed" && task.status !== "discarded" && task.status !== "archived"
    );
  }
  const steps = stepsByParent();
  const now = /* @__PURE__ */ new Date();
  const tasks = picked.sort(compareTasks).slice(0, limit).map((task) => ({
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    parentId: task.parentId,
    remaining: fmtRemaining(task.dueAt, task.type, now),
    steps: steps.get(task.id) ?? { done: 0, total: 0 }
  }));
  return { scope, limit, tasks };
}
function getTaskTool(args) {
  const { subtasks, ...task } = getTaskWithSubtasks(requireId(args.id));
  return {
    ...task,
    subtasks: subtasks.map((step) => ({ id: step.id, title: step.title, status: step.status })),
    requiresEvidence: task.requiresEvidence
  };
}
function listMessagesTool(args) {
  const limit = limitOf(args.limit, 30);
  const since = typeof args.since === "string" && args.since.trim() !== "" ? args.since : null;
  const messages = since ? textMessagesAfter(since, limit) : recentChatMessages(limit);
  return {
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.contentMd,
      mode: message.mode,
      createdAt: message.createdAt,
      attachments: message.attachments.length
    }))
  };
}
function getPointsTool(args) {
  const range = rangeArgOf(args.range);
  const bounds = rangeOf(range);
  const entries = listLedger({ from: bounds.from, to: bounds.to, limit: 100 });
  return {
    range,
    total: pointsInRange(bounds),
    items: entries.slice().reverse().map((entry) => ({
      at: entry.createdAt,
      delta: entry.delta,
      reason: entry.reasonText,
      taskId: entry.taskId
    }))
  };
}
function sinceMinutesOf(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 60;
  return Math.min(1440, Math.max(1, Math.floor(raw)));
}
function listAlertsTool(args) {
  const sinceMinutes = sinceMinutesOf(args.sinceMinutes);
  const now = /* @__PURE__ */ new Date();
  const alerts = listSince(sinceMinutes * 6e4, now).slice(-100);
  return {
    now: localIsoNow(),
    alerts: alerts.map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      level: alert.level,
      sourceId: alert.sourceId,
      title: alert.title,
      firedAt: alert.firedAt,
      acked: alert.ackedAt !== null,
      escalated: alert.escalatedAt !== null,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(alert.firedAt)) / 1e3))
    }))
  };
}
function callTool(name2, args = {}) {
  switch (name2) {
    case "get_overview":
      return getOverview();
    case "list_tasks":
      return listTasksTool(args);
    case "get_task":
      return getTaskTool(args);
    case "list_messages":
      return listMessagesTool(args);
    case "get_points":
      return getPointsTool(args);
    case "list_alerts":
      return listAlertsTool(args);
    default:
      throw new Error(`未知工具：${name2}`);
  }
}
const PROTOCOL_VERSION = "2025-06-18";
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function resultOf(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function errorOf(id, error) {
  return { jsonrpc: "2.0", id: id ?? null, error };
}
async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function paramsOf(params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return {};
  return params;
}
function toolArgs(params) {
  const raw = paramsOf(params).arguments;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}
function toolName(params) {
  const raw = paramsOf(params).name;
  return typeof raw === "string" ? raw : "";
}
function oneLineError(e) {
  const message = e instanceof Error ? e.message : "工具执行失败";
  return message.split("\n")[0] || "工具执行失败";
}
async function handle(token, req, res) {
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/mcp") {
    res.writeHead(404);
    res.end();
    return;
  }
  if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
    sendJson(res, 401, {});
    return;
  }
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, {});
    return;
  }
  let request;
  try {
    request = JSON.parse(await bodyOf(req));
  } catch {
    sendJson(res, 200, errorOf(null, { code: -32700, message: "请求体不是合法 JSON" }));
    return;
  }
  const id = request?.id ?? null;
  const params = request?.params;
  switch (request?.method) {
    case "initialize":
      sendJson(
        res,
        200,
        resultOf(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "taskloop", version: pkg.version }
        })
      );
      return;
    case "notifications/initialized":
      res.writeHead(202);
      res.end();
      return;
    case "tools/list":
      sendJson(res, 200, resultOf(id, { tools: MCP_TOOLS }));
      return;
    case "tools/call": {
      let result;
      try {
        result = {
          content: [{ type: "text", text: JSON.stringify(callTool(toolName(params), toolArgs(params))) }]
        };
      } catch (e) {
        result = { content: [{ type: "text", text: oneLineError(e) }], isError: true };
      }
      sendJson(res, 200, resultOf(id, result));
      return;
    }
    case "ping":
      sendJson(res, 200, resultOf(id, {}));
      return;
    default:
      sendJson(res, 200, errorOf(id, { code: -32601, message: "方法不存在" }));
  }
}
function startMcpServer(port2) {
  return new Promise((resolve) => {
    const noop = { port: port2, close: () => Promise.resolve() };
    const token = readOrCreateToken();
    if (token === null) {
      console.warn("[mcp] 读取 token 失败，服务未启动");
      resolve(noop);
      return;
    }
    const server = node_http.createServer((req, res) => {
      void handle(token, req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, {});
        else res.end();
      });
    });
    let settled = false;
    let closed = false;
    server.once("error", (err) => {
      if (settled) return;
      settled = true;
      console.warn(`[mcp] 端口 ${port2} 被占用，服务未启动：${err.message}`);
      resolve(noop);
    });
    server.listen(port2, "127.0.0.1", () => {
      if (settled) return;
      settled = true;
      const address = server.address();
      const actualPort = address !== null && typeof address === "object" ? address.port : port2;
      resolve({
        port: actualPort,
        close: async () => {
          if (closed) return;
          closed = true;
          server.closeAllConnections?.();
          await new Promise((done, fail2) => {
            server.close((err) => err ? fail2(err) : done());
          });
        }
      });
    });
  });
}
const MCP_PORT = 17321;
let closeServer = null;
async function startMcp() {
  const token = readOrCreateToken();
  if (token === null) {
    console.warn("[mcp] 读取 token 失败，服务未启动");
    return;
  }
  const running = await startMcpServer(MCP_PORT);
  closeServer = running.close;
}
async function stopMcp() {
  const close = closeServer;
  closeServer = null;
  if (close !== null) await close();
}
const ALERT_TICK_MS = 5e3;
function startAlertScheduler() {
  const run = () => {
    try {
      escalateDue(/* @__PURE__ */ new Date());
    } catch (e) {
      console.warn("[alert] 本轮扫描失败", e);
    }
  };
  const timer = setInterval(run, ALERT_TICK_MS);
  return () => clearInterval(timer);
}
const PULSE_TICK_MS = 2e4;
function firePulse(pulse, now) {
  markFired(pulse.id, now.toISOString());
  showNotice({
    level: "normal",
    title: pulse.title,
    remainLabel: "",
    typeLabel: "",
    dueLabel: "",
    reminderId: pulse.id
  });
}
function startPulseScheduler() {
  const run = () => {
    try {
      const now = /* @__PURE__ */ new Date();
      for (const pulse of listEnabled()) {
        if (isDue(pulse, now)) firePulse(pulse, now);
      }
    } catch (e) {
      console.warn("[pulse] 本轮扫描失败", e);
    }
  };
  try {
    resetLastFired(nowIso());
  } catch (e) {
    console.warn("[pulse] 启动重置失败", e);
  }
  const timer = setInterval(run, PULSE_TICK_MS);
  return () => clearInterval(timer);
}
const REMINDER_TICK_MS = 3e4;
function catchUpMissed(now) {
  const due = listDue(now.toISOString());
  if (due.length === 0) return;
  const nowMs = now.getTime();
  const inWindow2 = due.filter((reminder) => {
    const at = Date.parse(reminder.fireAt);
    return !Number.isNaN(at) && nowMs - at <= STALE_POPUP_MS;
  });
  const latest2 = inWindow2.length > 0 ? inWindow2[inWindow2.length - 1] : null;
  for (const reminder of due) {
    if (latest2 !== null && reminder.id === latest2.id) continue;
    try {
      markFired$1(reminder.id, [], nowIso());
    } catch (e) {
      console.warn("[reminder] 错过的一条没能收口", reminder.id, e);
    }
  }
  if (latest2 === null) return;
  try {
    fireOne(latest2);
  } catch (e) {
    console.warn("[reminder] 补发失败", latest2.id, e);
  }
}
function startReminderScheduler() {
  const run = () => {
    try {
      ensureRepeatHorizon(/* @__PURE__ */ new Date());
      fireDue(/* @__PURE__ */ new Date());
    } catch (e) {
      console.warn("[reminder] 本轮扫描失败", e);
    }
  };
  try {
    try {
      purgeInactiveTaskReminders();
    } catch (e) {
      console.warn("[reminder] 已删任务的提醒清场失败", e);
    }
    catchUpMissed(/* @__PURE__ */ new Date());
    syncAll();
    ensureRepeatHorizon(/* @__PURE__ */ new Date());
  } catch (e) {
    console.warn("[reminder] 启动补发判定失败", e);
  }
  const timer = setInterval(run, REMINDER_TICK_MS);
  return () => clearInterval(timer);
}
const REVIEW_TIMEOUT_MS = 6e5;
const SWEEP_INTERVAL_MS = 6e4;
function sweepPendingReview(now = /* @__PURE__ */ new Date()) {
  const deadline = now.getTime() - REVIEW_TIMEOUT_MS;
  const stale = listTasks({ status: ["pending_review"] }).filter((task) => {
    const updated = Date.parse(task.updatedAt);
    if (Number.isNaN(updated)) return false;
    return updated <= deadline;
  });
  const revived = [];
  for (const task of stale) {
    try {
      const current2 = getById$5(task.id);
      if (current2 === null || current2.status !== "pending_review" || current2.updatedAt !== task.updatedAt) {
        continue;
      }
      const updated = transitionTask(task.id, "doing");
      broadcast({ type: "task.updated", task: updated, changed: ["status", "updatedAt"] });
      revived.push(updated);
    } catch (e) {
      console.warn("[review] 待提交超时退回失败", task.id, e);
    }
  }
  return revived;
}
function startReviewSweeper() {
  const run = () => {
    try {
      sweepPendingReview();
    } catch (e) {
      console.warn("[review] sweeper 本轮失败", e);
    }
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
const FX_SWEEP_INTERVAL_MS = 30 * 60 * 1e3;
function startFxSweeper() {
  const run = () => {
    void ensureWeek().catch((e) => {
      console.warn("[fx] sweeper 本轮失败", e);
    });
  };
  run();
  const timer = setInterval(run, FX_SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
let stopReviewSweeper = null;
let stopFxSweeper = null;
let stopReminderScheduler = null;
let stopPulseScheduler = null;
let stopAlertScheduler = null;
let startupUpdateTimer = null;
let lhmTimer = null;
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  registerAttachmentScheme();
  electron.app.on("second-instance", () => {
    showMainWindow();
  });
  electron.app.whenReady().then(() => {
    initDb();
    void startMcp();
    console.log("[main] initDb() invoked");
    registerAttachmentProtocol();
    seedAutoStart();
    createMainWindow({ show: !isAutoStart(process.argv) });
    createHudWindow();
    registerIpcHandlers();
    console.log("[main] registerIpcHandlers() invoked");
    stopReviewSweeper = startReviewSweeper();
    stopFxSweeper = startFxSweeper();
    stopReminderScheduler = startReminderScheduler();
    stopPulseScheduler = startPulseScheduler();
    stopAlertScheduler = startAlertScheduler();
    startupUpdateTimer = setTimeout(() => {
      void runStartupUpdateCheck();
    }, 8e3);
    lhmTimer = setTimeout(() => {
      void ensureLhmStarted();
    }, 3e3);
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}
electron.app.on("before-quit", () => {
  stopReviewSweeper?.();
  stopReviewSweeper = null;
  stopFxSweeper?.();
  stopFxSweeper = null;
  stopReminderScheduler?.();
  stopReminderScheduler = null;
  stopPulseScheduler?.();
  stopPulseScheduler = null;
  stopAlertScheduler?.();
  stopAlertScheduler = null;
  if (startupUpdateTimer !== null) {
    clearTimeout(startupUpdateTimer);
    startupUpdateTimer = null;
  }
  if (lhmTimer !== null) {
    clearTimeout(lhmTimer);
    lhmTimer = null;
  }
  clearExitTimers();
  void stopMcp();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
