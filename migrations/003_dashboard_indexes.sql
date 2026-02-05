-- 仪表盘统计索引
-- 用于加速按日期聚合的查询

-- 生成图片按日期索引（用于每日生成统计）
CREATE INDEX IF NOT EXISTS idx_images_created_date
ON generated_images(date(created_at, 'unixepoch'));

-- 任务按完成日期索引（用于每日任务统计）
CREATE INDEX IF NOT EXISTS idx_tasks_completed_date
ON tasks(date(completed_at, 'unixepoch'));

-- 用户按创建日期索引（用于用户增长统计）
CREATE INDEX IF NOT EXISTS idx_users_created_date
ON users(date(created_at, 'unixepoch'));
