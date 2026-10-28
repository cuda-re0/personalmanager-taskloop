-- 001_init.sql — 首次建库。
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
  estimate_min    INTEGER,                        -- 预估分钟，影响积分

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
  tasks_done      INTEGER NOT NULL DEFAULT 0,  -- 含每日任务当天完成数
  tasks_created   INTEGER NOT NULL DEFAULT 0,
  occurrences_done INTEGER NOT NULL DEFAULT 0  -- 每日任务完成数
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
