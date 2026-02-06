-- 游标分页和性能优化索引
-- 运行: wrangler d1 execute lyra-db --file=./migrations/006_cursor_pagination_indexes.sql

-- Session token 索引 - 每次请求都需要验证 token
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- 复合索引优化：公开画廊查询 (is_public = 1 AND created_at < ?)
-- 注意：001_init.sql 已有 idx_images_public，但我们需要确保它是最优的
-- 如果需要重建，可以先删除再创建：
-- DROP INDEX IF EXISTS idx_images_public;
-- CREATE INDEX idx_images_public ON generated_images(is_public, created_at DESC);

-- 复合索引优化：用户历史查询 (user_id = ? AND created_at < ?)
-- 注意：001_init.sql 已有 idx_images_user_created

-- 任务表：按状态和创建时间查询（用于队列处理）
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at ASC);

-- 任务表：按批次ID查询（用于批量任务）
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id) WHERE batch_id IS NOT NULL;

-- 生成图片表：按类型统计（用于管理面板）
CREATE INDEX IF NOT EXISTS idx_images_type ON generated_images(type);

-- 反馈表：按图片ID查询（用于获取评分统计）
CREATE INDEX IF NOT EXISTS idx_feedback_image ON feedback(image_id);
