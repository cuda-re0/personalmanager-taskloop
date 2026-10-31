-- v0.45 · 零花钱（45 §4.1）
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
