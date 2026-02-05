-- 添加 batch_id 字段用于关联同一批次任务
ALTER TABLE tasks ADD COLUMN batch_id TEXT;

-- 创建批次索引
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);
