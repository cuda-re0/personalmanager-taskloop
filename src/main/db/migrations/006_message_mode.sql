-- v0.73：消息带上发送时的输入模式（chat / task）。
-- 可空：本迁移之前的老行拿不到这个信息，渲染层按「轮」推断兜底（73 §G）。
ALTER TABLE messages ADD COLUMN mode TEXT;
