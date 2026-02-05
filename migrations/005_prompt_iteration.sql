-- 提示词迭代支持
-- 允许图片之间建立父子关系，形成迭代链

-- 添加父图片引用
ALTER TABLE generated_images ADD COLUMN parent_image_id TEXT;

-- 创建索引用于查询迭代链
CREATE INDEX IF NOT EXISTS idx_images_parent
ON generated_images(parent_image_id);
