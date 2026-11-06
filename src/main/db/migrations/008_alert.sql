CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  acked_at TEXT,
  escalated_at TEXT
);
