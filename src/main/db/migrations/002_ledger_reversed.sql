-- 002_ledger_reversed：撤销后允许重做
--
-- 问题（v0.19，W6 审核实测）：
--   撤销走的是「写一条负的 manual_adjust 行」，原 task_done 行仍留在表里。
--   两条条件唯一索引都不看「是否已被冲销」，于是重做时新插入的发分行必然撞索引：
--     task 级：CONFLICT「这个任务已经发过完成分了」
--     occurrence 级：CONFLICT「这一天的打卡已经发过分了」
--   每日任务是高频路径，误点一次撤销后当天再也打不上卡。
--
-- 修法：
--   point_ledger 加 reversed_at（被冲销的时刻，NULL = 仍然有效）。
--   两条唯一索引的谓词都加 `AND reversed_at IS NULL`——它们要约束的是
--   「同时最多一条有效发分行」，而不是「历史上只许出现一条」。
--   撤销时把原发分行标上 reversed_at（审计仍能查出哪条被冲了、什么时候冲的），
--   负流水照写，余额仍是 SUM(delta)。
--
-- 注意：索引必须先 DROP 再 CREATE，SQLite 不支持 ALTER INDEX。

ALTER TABLE point_ledger ADD COLUMN reversed_at TEXT;

DROP INDEX uq_ledger_task_done;
CREATE UNIQUE INDEX uq_ledger_task_done
  ON point_ledger(task_id)
  WHERE reason_code = 'task_done' AND occurrence_id IS NULL AND reversed_at IS NULL;

DROP INDEX uq_ledger_occurrence;
CREATE UNIQUE INDEX uq_ledger_occurrence
  ON point_ledger(occurrence_id)
  WHERE occurrence_id IS NOT NULL AND reversed_at IS NULL;
