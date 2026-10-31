-- 003_chat.sql — 生活助手的三张表（v0.37 · W12）。
-- 内容逐字来自 docs/01-DATA-MODEL.md §2.8~2.10。
-- 与 001/002 同一条规矩：迁移不写业务数据（§5）——personas / memories / chat_state
-- 建成后一行都不预置，人物卡的默认行由 persona.get 就地建（§2.8）。

CREATE TABLE personas (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,                 -- 助手名字，1~20 字
  user_call  TEXT NOT NULL DEFAULT '',      -- 怎么称呼用户，空串 = 用「你」
  persona_md TEXT NOT NULL DEFAULT '',      -- 人设正文，≤ 800 字
  tone       TEXT NOT NULL DEFAULT 'warm',  -- warm|plain|playful
  is_active  INTEGER NOT NULL DEFAULT 1,    -- 0/1
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_personas_active ON personas(is_active) WHERE is_active = 1;

CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  content_md TEXT NOT NULL,                 -- 一条一句话，≤ 120 字
  kind       TEXT NOT NULL,                 -- profile|preference|fact
  source     TEXT NOT NULL,                 -- auto|manual
  hits       INTEGER NOT NULL DEFAULT 0,    -- 被带进 system prompt 的次数
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_memories_content ON memories(content_md);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);

CREATE TABLE chat_state (
  id              TEXT PRIMARY KEY,              -- 恒为 'main'
  summary_md      TEXT NOT NULL DEFAULT '',      -- 滚动窗口之前的历史摘要，≤ 600 字
  upto_message_id TEXT,                          -- 摘要已覆盖到哪一条（含）；NULL = 还没摘要过
  updated_at      TEXT NOT NULL
);
