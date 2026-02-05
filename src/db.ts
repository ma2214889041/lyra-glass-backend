import type { D1Database } from '@cloudflare/workers-types';
import type { Template, Tag, GeneratedImage, Task, Asset, Session, BatchProgress } from './types';

// ========== 标签操作 ==========
export const tagDb = {
  getAll: async (db: D1Database): Promise<Tag[]> => {
    const { results } = await db.prepare('SELECT * FROM tags ORDER BY created_at ASC').all();
    return results as Tag[];
  },

  create: async (db: D1Database, tag: Partial<Tag>): Promise<Tag> => {
    const id = tag.id || Date.now().toString();
    const name = tag.name!;
    const color = tag.color || '#6366f1';

    await db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)')
      .bind(id, name, color).run();
    return { id, name, color };
  },

  update: async (db: D1Database, id: string, updates: Partial<Tag>): Promise<Tag | null> => {
    const result = await db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?')
      .bind(updates.name, updates.color, id).run();
    if (result.meta.changes === 0) return null;
    return { id, name: updates.name!, color: updates.color! };
  },

  delete: async (db: D1Database, id: string): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  }
};

// ========== 模板操作 ==========
export const templateDb = {
  getAll: async (db: D1Database, options?: { tagFilter?: string; page?: number; limit?: number }): Promise<{ data: Template[]; total: number; page: number; limit: number }> => {
    const page = options?.page || 1;
    const limit = options?.limit || 12;
    const offset = (page - 1) * limit;

    // 获取总数
    const countResult = await db.prepare('SELECT COUNT(*) as count FROM templates').first<{ count: number }>();
    const total = countResult?.count || 0;

    // 获取分页数据
    const { results } = await db.prepare('SELECT * FROM templates ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?')
      .bind(limit, offset).all();

    let templates = results.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      thumbnailUrl: row.thumbnail_url || null,
      prompt: row.prompt || '',
      malePrompt: row.male_prompt || null,
      femalePrompt: row.female_prompt || null,
      defaultGender: row.default_gender || 'female',
      defaultFraming: row.default_framing || 'Close-up',
      tags: JSON.parse(row.tags || '[]'),
      variables: JSON.parse(row.variables || '[]')
    })) as Template[];

    if (options?.tagFilter) {
      templates = templates.filter(tpl => tpl.tags.includes(options.tagFilter!));
    }

    return { data: templates, total, page, limit };
  },

  getById: async (db: D1Database, id: string): Promise<Template | null> => {
    const row = await db.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!row) return null;

    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      imageUrl: row.image_url as string,
      prompt: (row.prompt as string) || '',
      malePrompt: row.male_prompt as string | null,
      femalePrompt: row.female_prompt as string | null,
      defaultGender: (row.default_gender as 'male' | 'female') || 'female',
      defaultFraming: (row.default_framing as string) || 'Close-up',
      tags: JSON.parse((row.tags as string) || '[]'),
      variables: JSON.parse((row.variables as string) || '[]')
    };
  },

  create: async (db: D1Database, template: Partial<Template>): Promise<Template> => {
    const id = template.id || `tpl_${Date.now()}`;
    await db.prepare(`
      INSERT INTO templates (id, name, description, image_url, prompt, male_prompt, female_prompt, default_gender, default_framing, tags, variables)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      template.name || '新模板',
      template.description || '',
      template.imageUrl || '',
      template.prompt || '',
      template.malePrompt || null,
      template.femalePrompt || null,
      template.defaultGender || 'female',
      template.defaultFraming || 'Close-up',
      JSON.stringify(template.tags || []),
      JSON.stringify(template.variables || [])
    ).run();

    return { ...template, id } as Template;
  },

  update: async (db: D1Database, id: string, updates: Partial<Template>): Promise<Template | null> => {
    const current = await templateDb.getById(db, id);
    if (!current) return null;

    const updated = { ...current, ...updates };
    await db.prepare(`
      UPDATE templates SET name = ?, description = ?, image_url = ?, prompt = ?,
        male_prompt = ?, female_prompt = ?, default_gender = ?, default_framing = ?,
        tags = ?, variables = ?, updated_at = unixepoch()
      WHERE id = ?
    `).bind(
      updated.name,
      updated.description,
      updated.imageUrl,
      updated.prompt,
      updated.malePrompt,
      updated.femalePrompt,
      updated.defaultGender,
      updated.defaultFraming,
      JSON.stringify(updated.tags),
      JSON.stringify(updated.variables),
      id
    ).run();

    return updated;
  },

  delete: async (db: D1Database, id: string): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  }
};

// ========== 用户操作 ==========
export const userDb = {
  create: async (db: D1Database, username: string, passwordHash: string) => {
    const result = await db.prepare(`
      INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')
    `).bind(username, passwordHash).run();

    return {
      id: result.meta.last_row_id as number,
      username,
      role: 'user' as const
    };
  },

  findByUsername: async (db: D1Database, username: string) => {
    return await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  },

  findById: async (db: D1Database, id: number) => {
    return await db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').bind(id).first();
  },

  usernameExists: async (db: D1Database, username: string): Promise<boolean> => {
    const row = await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
    return !!row;
  },

  updatePassword: async (db: D1Database, userId: number, passwordHash: string): Promise<boolean> => {
    const result = await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(passwordHash, userId).run();
    return result.meta.changes > 0;
  }
};

// ========== Session 操作 ==========
export const sessionDb = {
  create: async (
    db: D1Database,
    token: string,
    username: string,
    expiresInHours: number = 24,
    userId: number | null = null,
    role: string = 'admin'
  ): Promise<Session> => {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (expiresInHours * 60 * 60);

    await db.prepare(`
      INSERT INTO sessions (token, username, user_id, role, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(token, username, userId, role, now, expiresAt).run();

    return { username, userId, role: role as 'user' | 'admin', expiresAt };
  },

  validate: async (db: D1Database, token: string): Promise<Session | null> => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
      .bind(token, now).first();

    if (!row) return null;
    return {
      username: row.username as string,
      userId: row.user_id as number | null,
      role: (row.role as 'user' | 'admin') || 'admin',
      expiresAt: row.expires_at as number
    };
  },

  delete: async (db: D1Database, token: string): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return result.meta.changes > 0;
  },

  cleanup: async (db: D1Database): Promise<number> => {
    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
    return result.meta.changes;
  }
};

// ========== 图片记录操作 ==========
export const imageDb = {
  save: async (db: D1Database, image: Partial<GeneratedImage>, userId: number | null, parentImageId?: string) => {
    await db.prepare(`
      INSERT INTO generated_images (id, url, thumbnail_url, type, config, user_id, prompt, parent_image_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      image.id,
      image.url,
      image.thumbnailUrl || null,
      image.type,
      JSON.stringify(image.config || {}),
      userId,
      image.prompt || null,
      parentImageId || null
    ).run();

    return { ...image, userId, parentImageId };
  },

  getByUserId: async (db: D1Database, userId: number | null, limit: number = 50): Promise<GeneratedImage[]> => {
    let query: string;
    let params: (number | null)[];

    if (userId === null) {
      query = `SELECT * FROM generated_images ORDER BY created_at DESC LIMIT ?`;
      params = [limit];
    } else {
      query = `SELECT * FROM generated_images WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`;
      params = [userId, limit];
    }

    const { results } = await db.prepare(query).bind(...params).all();

    return results.map((row: any) => ({
      id: row.id,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      type: row.type,
      config: row.config ? JSON.parse(row.config) : null,
      prompt: row.prompt,
      userId: row.user_id,
      isPublic: row.is_public === 1,
      timestamp: row.created_at * 1000
    }));
  },

  getById: async (db: D1Database, imageId: string) => {
    const row = await db.prepare('SELECT * FROM generated_images WHERE id = ?').bind(imageId).first();
    if (!row) return null;

    return {
      id: row.id as string,
      url: row.url as string,
      thumbnailUrl: row.thumbnail_url as string | null,
      type: row.type as string,
      config: row.config ? JSON.parse(row.config as string) : null,
      prompt: row.prompt as string | null,
      userId: row.user_id as number | null,
      isPublic: row.is_public === 1,
      timestamp: (row.created_at as number) * 1000
    };
  },

  delete: async (db: D1Database, imageId: string): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM generated_images WHERE id = ?').bind(imageId).run();
    return result.meta.changes > 0;
  },

  updateThumbnail: async (db: D1Database, imageId: string, thumbnailUrl: string, userId: number): Promise<boolean> => {
    const result = await db.prepare(
      'UPDATE generated_images SET thumbnail_url = ? WHERE id = ? AND user_id = ?'
    ).bind(thumbnailUrl, imageId, userId).run();
    return result.meta.changes > 0;
  },

  getPublicImages: async (db: D1Database, limit: number = 50) => {
    const { results } = await db.prepare(`
      SELECT gi.*, u.username FROM generated_images gi
      LEFT JOIN users u ON gi.user_id = u.id
      WHERE gi.is_public = 1
      ORDER BY gi.created_at DESC LIMIT ?
    `).bind(limit).all();

    return results.map((row: any) => ({
      id: row.id,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      type: row.type,
      config: row.config ? JSON.parse(row.config) : null,
      prompt: row.prompt,
      timestamp: row.created_at * 1000,
      isPublic: true,
      username: row.username || '匿名用户'
    }));
  },

  setPublic: async (db: D1Database, imageId: string, isPublic: boolean, userId: number) => {
    const image = await db.prepare('SELECT user_id FROM generated_images WHERE id = ?').bind(imageId).first();
    if (!image || image.user_id !== userId) {
      return { success: false, error: '无权操作此图片' };
    }

    await db.prepare('UPDATE generated_images SET is_public = ? WHERE id = ?')
      .bind(isPublic ? 1 : 0, imageId).run();
    return { success: true };
  },

  // 获取图片的迭代链（包括父级和子级）
  getIterations: async (db: D1Database, imageId: string): Promise<GeneratedImage[]> => {
    // 先获取当前图片找到根节点
    let rootId = imageId;
    let current = await db.prepare('SELECT parent_image_id FROM generated_images WHERE id = ?').bind(imageId).first();

    // 向上查找根节点
    while (current && current.parent_image_id) {
      rootId = current.parent_image_id as string;
      current = await db.prepare('SELECT parent_image_id FROM generated_images WHERE id = ?').bind(rootId).first();
    }

    // 从根节点获取所有迭代（包括根节点本身和所有子节点）
    const { results } = await db.prepare(`
      WITH RECURSIVE iteration_chain AS (
        SELECT * FROM generated_images WHERE id = ?
        UNION ALL
        SELECT gi.* FROM generated_images gi
        JOIN iteration_chain ic ON gi.parent_image_id = ic.id
      )
      SELECT * FROM iteration_chain ORDER BY created_at ASC
    `).bind(rootId).all();

    return results.map((row: any) => ({
      id: row.id,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      type: row.type,
      config: row.config ? JSON.parse(row.config) : null,
      prompt: row.prompt,
      userId: row.user_id,
      isPublic: row.is_public === 1,
      timestamp: row.created_at * 1000,
      parentImageId: row.parent_image_id
    }));
  }
};

// ========== 资源操作 ==========
export const assetDb = {
  getAll: async (db: D1Database): Promise<Asset[]> => {
    const { results } = await db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all();
    return results.map((row: any) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      type: row.type || 'image',
      timestamp: row.created_at * 1000
    }));
  },

  add: async (db: D1Database, asset: Partial<Asset>) => {
    await db.prepare(`
      INSERT INTO assets (id, name, url, thumbnail_url, type) VALUES (?, ?, ?, ?, ?)
    `).bind(asset.id, asset.name, asset.url, asset.thumbnailUrl || null, asset.type || 'image').run();
    return asset;
  },

  delete: async (db: D1Database, id: string): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  },

  getById: async (db: D1Database, id: string) => {
    return await db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first();
  }
};

// ========== 收藏操作 ==========
export const favoriteDb = {
  add: async (db: D1Database, userId: number, templateId: string): Promise<boolean> => {
    try {
      await db.prepare('INSERT INTO favorites (user_id, template_id) VALUES (?, ?)')
        .bind(userId, templateId).run();
      return true;
    } catch {
      return false; // UNIQUE 约束冲突
    }
  },

  remove: async (db: D1Database, userId: number, templateId: string): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM favorites WHERE user_id = ? AND template_id = ?')
      .bind(userId, templateId).run();
    return result.meta.changes > 0;
  },

  isFavorited: async (db: D1Database, userId: number, templateId: string): Promise<boolean> => {
    const row = await db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND template_id = ?')
      .bind(userId, templateId).first();
    return !!row;
  },

  getByUserId: async (db: D1Database, userId: number) => {
    const { results } = await db.prepare(`
      SELECT t.*, f.created_at as favorited_at FROM favorites f
      JOIN templates t ON f.template_id = t.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC
    `).bind(userId).all();

    return results.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      prompt: row.prompt || '',
      tags: JSON.parse(row.tags || '[]'),
      variables: JSON.parse(row.variables || '[]'),
      favoritedAt: row.favorited_at * 1000
    }));
  },

  getCount: async (db: D1Database, templateId: string): Promise<number> => {
    const row = await db.prepare('SELECT COUNT(*) as count FROM favorites WHERE template_id = ?')
      .bind(templateId).first();
    return (row?.count as number) || 0;
  }
};

// ========== 提示词历史操作 ==========
export const promptHistoryDb = {
  save: async (
    db: D1Database,
    userId: number,
    prompt: string,
    templateId: string | null = null,
    variables: Record<string, unknown> = {},
    isSuccessful: boolean = false
  ) => {
    const result = await db.prepare(`
      INSERT INTO prompt_history (user_id, template_id, prompt, variables, is_successful)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, templateId, prompt, JSON.stringify(variables), isSuccessful ? 1 : 0).run();
    return result.meta.last_row_id;
  },

  getByUserId: async (db: D1Database, userId: number, limit: number = 50) => {
    const { results } = await db.prepare(`
      SELECT * FROM prompt_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).bind(userId, limit).all();

    return results.map((row: any) => ({
      id: row.id,
      templateId: row.template_id,
      prompt: row.prompt,
      variables: JSON.parse(row.variables || '{}'),
      isSuccessful: row.is_successful === 1,
      timestamp: row.created_at * 1000
    }));
  },

  getSuccessful: async (db: D1Database, userId: number, limit: number = 20) => {
    const { results } = await db.prepare(`
      SELECT * FROM prompt_history WHERE user_id = ? AND is_successful = 1
      ORDER BY created_at DESC LIMIT ?
    `).bind(userId, limit).all();

    return results.map((row: any) => ({
      id: row.id,
      templateId: row.template_id,
      prompt: row.prompt,
      variables: JSON.parse(row.variables || '{}'),
      timestamp: row.created_at * 1000
    }));
  },

  delete: async (db: D1Database, id: number, userId: number): Promise<boolean> => {
    const result = await db.prepare('DELETE FROM prompt_history WHERE id = ? AND user_id = ?')
      .bind(id, userId).run();
    return result.meta.changes > 0;
  }
};

// ========== 反馈操作 ==========
export const feedbackDb = {
  upsert: async (db: D1Database, userId: number, imageId: string, rating: number) => {
    try {
      await db.prepare('INSERT INTO feedback (user_id, image_id, rating) VALUES (?, ?, ?)')
        .bind(userId, imageId, rating).run();
    } catch {
      await db.prepare('UPDATE feedback SET rating = ? WHERE user_id = ? AND image_id = ?')
        .bind(rating, userId, imageId).run();
    }
    return true;
  },

  get: async (db: D1Database, userId: number, imageId: string): Promise<number | null> => {
    const row = await db.prepare('SELECT rating FROM feedback WHERE user_id = ? AND image_id = ?')
      .bind(userId, imageId).first();
    return row ? (row.rating as number) : null;
  },

  getStats: async (db: D1Database, imageId: string) => {
    const row = await db.prepare(`
      SELECT
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as likes,
        SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as dislikes
      FROM feedback WHERE image_id = ?
    `).bind(imageId).first();

    return {
      likes: (row?.likes as number) || 0,
      dislikes: (row?.dislikes as number) || 0
    };
  },

  getTemplateStats: async (db: D1Database, templateId: string) => {
    const row = await db.prepare(`
      SELECT
        SUM(CASE WHEN f.rating = 1 THEN 1 ELSE 0 END) as likes,
        SUM(CASE WHEN f.rating = -1 THEN 1 ELSE 0 END) as dislikes,
        COUNT(f.id) as total
      FROM feedback f
      JOIN generated_images g ON f.image_id = g.id
      WHERE json_extract(g.config, '$.templateId') = ?
    `).bind(templateId).first();

    const likes = (row?.likes as number) || 0;
    const total = (row?.total as number) || 0;

    return {
      likes,
      dislikes: (row?.dislikes as number) || 0,
      total,
      satisfaction: total > 0 ? Math.round((likes / total) * 100) : null
    };
  }
};

// ========== 任务队列操作 ==========
export const taskDb = {
  create: async (
    db: D1Database,
    taskId: string,
    userId: number,
    type: string,
    inputData: Record<string, unknown>,
    batchId?: string
  ): Promise<Task> => {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`
      INSERT INTO tasks (id, user_id, type, input_data, status, progress, batch_id, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    `).bind(taskId, userId, type, JSON.stringify(inputData), batchId || null, now).run();

    return {
      id: taskId,
      userId,
      type: type as 'generate' | 'batch' | 'product_shot',
      status: 'pending',
      progress: 0,
      inputData,
      outputData: null,
      errorMessage: null,
      batchId: batchId || null,
      createdAt: now * 1000,
      startedAt: null,
      completedAt: null
    };
  },

  getPending: async (db: D1Database, limit: number = 10) => {
    const { results } = await db.prepare(`
      SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
    `).bind(limit).all();

    return results.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      type: row.type,
      status: row.status,
      inputData: JSON.parse(row.input_data),
      createdAt: row.created_at * 1000
    }));
  },

  startProcessing: async (db: D1Database, taskId: string): Promise<boolean> => {
    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare(`
      UPDATE tasks SET status = 'processing', started_at = ?, progress = 10
      WHERE id = ? AND status = 'pending'
    `).bind(now, taskId).run();
    return result.meta.changes > 0;
  },

  updateProgress: async (db: D1Database, taskId: string, progress: number): Promise<boolean> => {
    const result = await db.prepare('UPDATE tasks SET progress = ? WHERE id = ?')
      .bind(progress, taskId).run();
    return result.meta.changes > 0;
  },

  complete: async (db: D1Database, taskId: string, outputData: Record<string, unknown>): Promise<boolean> => {
    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare(`
      UPDATE tasks SET status = 'completed', output_data = ?, completed_at = ?, progress = 100
      WHERE id = ?
    `).bind(JSON.stringify(outputData), now, taskId).run();
    return result.meta.changes > 0;
  },

  fail: async (db: D1Database, taskId: string, errorMessage: string): Promise<boolean> => {
    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare(`
      UPDATE tasks SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
    `).bind(errorMessage, now, taskId).run();
    return result.meta.changes > 0;
  },

  getById: async (db: D1Database, taskId: string): Promise<Task | null> => {
    const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    if (!row) return null;

    return {
      id: row.id as string,
      userId: row.user_id as number,
      type: row.type as 'generate' | 'batch' | 'product_shot',
      status: row.status as Task['status'],
      progress: row.progress as number,
      inputData: JSON.parse(row.input_data as string),
      outputData: row.output_data ? JSON.parse(row.output_data as string) : null,
      errorMessage: row.error_message as string | null,
      batchId: (row.batch_id as string) || null,
      createdAt: (row.created_at as number) * 1000,
      startedAt: row.started_at ? (row.started_at as number) * 1000 : null,
      completedAt: row.completed_at ? (row.completed_at as number) * 1000 : null
    };
  },

  getByUserId: async (db: D1Database, userId: number, limit: number = 50) => {
    const { results } = await db.prepare(`
      SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).bind(userId, limit).all();

    return results.map((row: any) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      progress: row.progress,
      inputData: JSON.parse(row.input_data),
      outputData: row.output_data ? JSON.parse(row.output_data) : null,
      errorMessage: row.error_message,
      createdAt: row.created_at * 1000,
      startedAt: row.started_at ? row.started_at * 1000 : null,
      completedAt: row.completed_at ? row.completed_at * 1000 : null
    }));
  },

  getActiveTasks: async (db: D1Database, userId: number) => {
    const { results } = await db.prepare(`
      SELECT * FROM tasks WHERE user_id = ? AND status IN ('pending', 'processing')
      ORDER BY created_at ASC
    `).bind(userId).all();

    return results.map((row: any) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      progress: row.progress,
      inputData: JSON.parse(row.input_data),
      batchId: row.batch_id || null,
      createdAt: row.created_at * 1000,
      startedAt: row.started_at ? row.started_at * 1000 : null
    }));
  },

  getByBatchId: async (db: D1Database, batchId: string): Promise<Task[]> => {
    const { results } = await db.prepare(`
      SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC
    `).bind(batchId).all();

    return results.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      type: row.type as 'generate' | 'batch' | 'product_shot',
      status: row.status as Task['status'],
      progress: row.progress,
      inputData: JSON.parse(row.input_data),
      outputData: row.output_data ? JSON.parse(row.output_data) : null,
      errorMessage: row.error_message,
      batchId: row.batch_id,
      createdAt: row.created_at * 1000,
      startedAt: row.started_at ? row.started_at * 1000 : null,
      completedAt: row.completed_at ? row.completed_at * 1000 : null
    }));
  },

  getBatchProgress: async (db: D1Database, batchId: string): Promise<BatchProgress> => {
    const row = await db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM tasks WHERE batch_id = ?
    `).bind(batchId).first();

    return {
      total: (row?.total as number) || 0,
      completed: (row?.completed as number) || 0,
      failed: (row?.failed as number) || 0,
      processing: (row?.processing as number) || 0,
      pending: (row?.pending as number) || 0
    };
  },

  getQueueStats: async (db: D1Database) => {
    const row = await db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
    `).first();

    return {
      pending: (row?.pending as number) || 0,
      processing: (row?.processing as number) || 0,
      completed: (row?.completed as number) || 0,
      failed: (row?.failed as number) || 0
    };
  },

  cleanup: async (db: D1Database, daysToKeep: number = 7): Promise<number> => {
    const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
    const result = await db.prepare(`
      DELETE FROM tasks WHERE status IN ('completed', 'failed') AND completed_at < ?
    `).bind(cutoff).run();
    return result.meta.changes;
  },

  resetStuckTasks: async (db: D1Database): Promise<number> => {
    const cutoff = Math.floor(Date.now() / 1000) - (10 * 60); // 10 分钟
    const result = await db.prepare(`
      UPDATE tasks SET status = 'pending', started_at = NULL, progress = 0
      WHERE status = 'processing' AND started_at < ?
    `).bind(cutoff).run();
    return result.meta.changes;
  },

  // 取消任务（只能取消 pending 状态的任务）
  cancel: async (db: D1Database, taskId: string, userId: number): Promise<{ success: boolean; message: string }> => {
    // 先检查任务是否存在且属于该用户
    const task = await db.prepare(`
      SELECT id, status, user_id FROM tasks WHERE id = ?
    `).bind(taskId).first();

    if (!task) {
      return { success: false, message: '任务不存在' };
    }

    if (task.user_id !== userId) {
      return { success: false, message: '无权取消此任务' };
    }

    if (task.status === 'completed') {
      return { success: false, message: '任务已完成，无法取消' };
    }

    if (task.status === 'failed') {
      return { success: false, message: '任务已失败' };
    }

    // 取消任务（标记为 cancelled 状态）
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`
      UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?
    `).bind(now, taskId).run();

    return { success: true, message: '任务已取消' };
  },

  // 获取用户的已完成任务
  getCompletedTasks: async (db: D1Database, userId: number, limit: number = 50) => {
    const { results } = await db.prepare(`
      SELECT * FROM tasks WHERE user_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT ?
    `).bind(userId, limit).all();

    return results.map((row: any) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      progress: row.progress,
      inputData: JSON.parse(row.input_data),
      outputData: row.output_data ? JSON.parse(row.output_data) : null,
      errorMessage: row.error_message,
      batchId: row.batch_id || null,
      createdAt: row.created_at * 1000,
      startedAt: row.started_at ? row.started_at * 1000 : null,
      completedAt: row.completed_at ? row.completed_at * 1000 : null
    }));
  }
};

// ========== 统计数据 ==========
export const statsDb = {
  // 获取总用户数
  getTotalUsers: async (db: D1Database): Promise<number> => {
    const result = await db.prepare('SELECT COUNT(*) as count FROM users').first();
    return (result as any)?.count || 0;
  },

  // 获取总生成数
  getTotalGenerations: async (db: D1Database): Promise<number> => {
    const result = await db.prepare('SELECT COUNT(*) as count FROM generated_images').first();
    return (result as any)?.count || 0;
  },

  // 获取总模板数
  getTotalTemplates: async (db: D1Database): Promise<number> => {
    const result = await db.prepare('SELECT COUNT(*) as count FROM templates').first();
    return (result as any)?.count || 0;
  },

  // 获取热门模板（按收藏数+使用数排序）
  getPopularTemplates: async (db: D1Database, limit: number = 10) => {
    const { results } = await db.prepare(`
      SELECT
        t.id,
        t.name,
        t.image_url as imageUrl,
        COUNT(DISTINCT f.user_id) as favoriteCount,
        COUNT(DISTINCT g.id) as usageCount
      FROM templates t
      LEFT JOIN favorites f ON t.id = f.template_id
      LEFT JOIN generated_images g ON json_extract(g.config, '$.templateId') = t.id
      GROUP BY t.id
      ORDER BY (favoriteCount + usageCount) DESC
      LIMIT ?
    `).bind(limit).all();

    return results.map((row: any) => ({
      id: row.id,
      name: row.name,
      imageUrl: row.imageUrl,
      favoriteCount: row.favoriteCount || 0,
      usageCount: row.usageCount || 0
    }));
  },

  // 获取最近活动（最近的生成记录）
  getRecentActivity: async (db: D1Database, limit: number = 20) => {
    const { results } = await db.prepare(`
      SELECT
        g.id,
        g.type,
        g.created_at as createdAt,
        u.username
      FROM generated_images g
      LEFT JOIN users u ON g.user_id = u.id
      ORDER BY g.created_at DESC
      LIMIT ?
    `).bind(limit).all();

    return results.map((row: any) => ({
      id: row.id,
      type: row.type,
      createdAt: (row.createdAt || 0) * 1000,
      username: row.username || '匿名'
    }));
  },

  // 获取每日统计（最近 N 天）
  getDailyStats: async (db: D1Database, days: number = 7) => {
    const { results } = await db.prepare(`
      SELECT
        date(created_at, 'unixepoch') as date,
        COUNT(*) as count
      FROM generated_images
      WHERE created_at >= unixepoch('now', '-' || ? || ' days')
      GROUP BY date(created_at, 'unixepoch')
      ORDER BY date ASC
    `).bind(days).all();

    return results.map((row: any) => ({
      date: row.date,
      count: row.count || 0
    }));
  },

  // 获取用户增长统计（最近 N 天）
  getUserGrowth: async (db: D1Database, days: number = 7) => {
    const { results } = await db.prepare(`
      SELECT
        date(created_at, 'unixepoch') as date,
        COUNT(*) as count
      FROM users
      WHERE created_at >= unixepoch('now', '-' || ? || ' days')
      GROUP BY date(created_at, 'unixepoch')
      ORDER BY date ASC
    `).bind(days).all();

    return results.map((row: any) => ({
      date: row.date,
      count: row.count || 0
    }));
  },

  // 获取按类型的生成统计
  getGenerationsByType: async (db: D1Database) => {
    const { results } = await db.prepare(`
      SELECT type, COUNT(*) as count
      FROM generated_images
      GROUP BY type
      ORDER BY count DESC
    `).all();

    return results.map((row: any) => ({
      type: row.type,
      count: row.count || 0
    }));
  }
};
