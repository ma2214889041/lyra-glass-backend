-- Stripe 订阅集成

-- 用户表添加 Stripe 相关字段
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'inactive';
ALTER TABLE users ADD COLUMN subscription_ends_at INTEGER;

-- Stripe 事件日志表（防止重复处理）
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at INTEGER DEFAULT (unixepoch())
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(type, processed_at);
