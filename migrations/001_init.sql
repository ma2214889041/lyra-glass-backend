-- Lyra D1 数据库初始化
-- 运行: wrangler d1 execute lyra-db --file=./migrations/001_init.sql

-- 模板表
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  male_prompt TEXT,
  female_prompt TEXT,
  default_gender TEXT DEFAULT 'female',
  default_framing TEXT DEFAULT 'Close-up',
  tags TEXT DEFAULT '[]',
  variables TEXT DEFAULT '[]',
  has_text INTEGER DEFAULT 0,
  has_title INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- 标签表
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#6366f1',
  created_at INTEGER DEFAULT (unixepoch())
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at INTEGER DEFAULT (unixepoch())
);

-- 资源表
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  type TEXT DEFAULT 'image',
  created_at INTEGER DEFAULT (unixepoch())
);

-- 生成图片记录表
CREATE TABLE IF NOT EXISTS generated_images (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  type TEXT NOT NULL,
  config TEXT,
  user_id INTEGER,
  prompt TEXT,
  is_public INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Session 表
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  user_id INTEGER,
  role TEXT DEFAULT 'user',
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 收藏表
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (template_id) REFERENCES templates(id),
  UNIQUE(user_id, template_id)
);

-- 提示词历史表
CREATE TABLE IF NOT EXISTS prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_id TEXT,
  prompt TEXT NOT NULL,
  variables TEXT DEFAULT '{}',
  is_successful INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 反馈表
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  image_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (image_id) REFERENCES generated_images(id),
  UNIQUE(user_id, image_id)
);

-- 任务队列表
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  input_data TEXT NOT NULL,
  output_data TEXT,
  error_message TEXT,
  progress INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_images_user_created ON generated_images(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_public ON generated_images(is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_history_user ON prompt_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 默认标签
INSERT OR IGNORE INTO tags (id, name, color) VALUES ('model', '模特试戴', '#6366f1');
INSERT OR IGNORE INTO tags (id, name, color) VALUES ('poster', '海报', '#ec4899');
INSERT OR IGNORE INTO tags (id, name, color) VALUES ('social', '社媒', '#14b8a6');
INSERT OR IGNORE INTO tags (id, name, color) VALUES ('ecommerce', '电商', '#f59e0b');
