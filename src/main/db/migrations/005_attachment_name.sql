-- v0.49：附件显示名。只加一列，不动 001–004。
-- 允许空串：本迁移之前落库的老行没有名字，渲染层按 mime 兜底（49 §5.2）。
-- 名字只用于显示，**永远不参与路径拼接**（落盘仍走 id + mime 推导）。
ALTER TABLE attachments ADD COLUMN name TEXT NOT NULL DEFAULT '';
