-- 用户等级和任务优先级系统

-- 用户等级字段
ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'free';

-- 任务优先级字段
ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;

-- 每日配额追踪
ALTER TABLE users ADD COLUMN daily_generation_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_generation_date TEXT;

-- 优先级索引（高优先级优先，同优先级按时间排序）
CREATE INDEX IF NOT EXISTS idx_tasks_priority
ON tasks(status, priority DESC, created_at ASC);
