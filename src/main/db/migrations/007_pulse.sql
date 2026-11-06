CREATE TABLE IF NOT EXISTS pulses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  window_start TEXT,
  window_end TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
