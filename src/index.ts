import { Hono, Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { Env, Session, QueueMessage } from './types';
import { TIER_CONFIGS } from './types';
import {
  registerSchema, loginSchema, changePasswordSchema,
  createTemplateSchema, updateTemplateSchema,
  createTagSchema, updateTagSchema,
  generateTemplateSchema, generateIterateSchema,
  setPublicSchema, submitFeedbackSchema,
  getFirstError
} from './validators';

// Hono Context 类型定义
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
import {
  tagDb, templateDb, userDb, sessionDb, imageDb, assetDb,
  favoriteDb, promptHistoryDb, feedbackDb, taskDb, statsDb
} from './db';
import {
  register, login, logout, changePassword, validateSession, extractToken
} from './auth';
import { saveImage, deleteImage, saveAsset, deleteAsset, getImage, saveThumbnail, cleanupOldImages, cleanupOrphanedAssets } from './storage';
import {
  generateEyewearImage, generatePosterImage, getPromptSuggestions,
  generateFromTemplate, optimizePrompt, generateProductShot
} from './gemini';
import { processTask, processPendingTasks, processBatchTasks } from './task_processor';
import { rateLimit } from './rateLimit';
import {
  createCheckoutSession, createPortalSession, handleWebhookEvent,
  verifyWebhookSignature, getSubscriptionStatus, TIER_PRICES
} from './stripe';

// 扩展 Hono Context
type Variables = {
  user: Session;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS 中间件
app.use('*', cors({
  origin: (origin) => {
    // 允许的域名列表
    const allowedOrigins = [
      'https://glass.lyrai.eu',
      'http://localhost:5173',
      'http://localhost:3000'
    ];

    // 如果在允许列表中，直接返回
    if (allowedOrigins.includes(origin)) return origin;

    // 允许 Cloudflare Pages 预览域名（仅限本项目）
    if (origin && origin.endsWith('.lyra-cwg.pages.dev')) {
      return origin;
    }

    // 生产环境：拒绝未知来源
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-goog-api-key'],
  exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
  maxAge: 600,
  credentials: true,
}));

// 全局错误处理中间件
app.onError((err, c) => {
  console.error(`[Global Error] ${c.req.method} ${c.req.path}:`, err);

  // 区分不同类型的错误
  if (err.message.includes('GEMINI_API_KEY')) {
    return c.json({ error: 'API 配置错误，请联系管理员' }, 500);
  }
  if (err.message.includes('Gemini API')) {
    return c.json({ error: 'AI 服务暂时不可用，请稍后重试' }, 503);
  }
  if (err.message.includes('D1') || err.message.includes('database')) {
    return c.json({ error: '数据库错误，请稍后重试' }, 500);
  }
  if (err.message.includes('R2')) {
    return c.json({ error: '存储服务错误，请稍后重试' }, 500);
  }

  // 默认错误响应（生产环境不暴露详细错误信息）
  return c.json({ error: '服务器内部错误' }, 500);
});

// 404 处理
app.notFound((c) => {
  return c.json({ error: '接口不存在' }, 404);
});

// 认证中间件
const authMiddleware = async (c: AppContext, next: Next) => {
  const token = extractToken(c.req.header('Authorization'));
  if (!token) {
    return c.json({ error: '未授权访问' }, 401);
  }

  const session = await validateSession(c.env.DB, c.env.SESSION_KV, token);
  if (!session) {
    return c.json({ error: 'Session 已过期，请重新登录' }, 401);
  }

  c.set('user', session);
  await next();
};

// 管理员中间件
const adminMiddleware = async (c: AppContext, next: Next) => {
  const token = extractToken(c.req.header('Authorization'));
  if (!token) {
    return c.json({ error: '未授权访问' }, 401);
  }

  const session = await validateSession(c.env.DB, c.env.SESSION_KV, token);
  if (!session) {
    return c.json({ error: 'Session 已过期，请重新登录' }, 401);
  }

  if (session.role !== 'admin') {
    return c.json({ error: '需要管理员权限' }, 403);
  }

  c.set('user', session);
  await next();
};

// ========== 私有图片鉴权缓存 ==========
const AUTH_CACHE_TTL = 5 * 60; // 5分钟

interface AuthCacheResult {
  userId: number;
  isAllowed: boolean;
}

// 检查鉴权缓存
async function checkAuthCache(token: string, imageId: string): Promise<AuthCacheResult | null> {
  const cache = caches.default;
  const cacheKey = new Request(`https://auth-cache/${token}/${imageId}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }
  return null;
}

// 设置鉴权缓存
async function setAuthCache(token: string, imageId: string, result: AuthCacheResult): Promise<void> {
  const cache = caches.default;
  const cacheKey = new Request(`https://auth-cache/${token}/${imageId}`);
  const response = new Response(JSON.stringify(result), {
    headers: { 'Cache-Control': `max-age=${AUTH_CACHE_TTL}` }
  });
  await cache.put(cacheKey, response);
}

// ========== R2 静态文件服务 (带访问控制) ==========
// 用户生成的图片通过 token 验证访问权限
app.get('/r2/*', async (c) => {
  const key = c.req.path.slice(4); // 去掉 /r2/ 前缀

  // 判断是否是用户生成的图片（需要访问控制）
  const isUserImage = key.startsWith('images/');

  if (isUserImage) {
    // 从路径提取 imageId: images/{imageId}.png 或 images/{imageId}_thumb.webp
    const filename = key.split('/').pop() || '';
    const imageId = filename.split('.')[0].replace('_thumb', '');

    // 查询图片信息
    const image = await imageDb.getById(c.env.DB, imageId);

    if (!image) {
      return c.json({ error: 'Image not found' }, 404);
    }

    // 如果图片不是公开的，需要验证身份
    if (!image.isPublic) {
      // 支持 query param 中的 token（用于 <img> 标签）
      const queryToken = c.req.query('token');
      const headerToken = extractToken(c.req.header('Authorization'));
      const token = queryToken || headerToken;

      if (!token) {
        return c.json({ error: '需要登录才能查看此图片' }, 401);
      }

      // 先检查鉴权缓存
      const cachedAuth = await checkAuthCache(token, imageId);

      if (cachedAuth) {
        // 缓存命中
        if (!cachedAuth.isAllowed) {
          return c.json({ error: '无权查看此图片' }, 403);
        }
        // 缓存命中且有权访问，继续返回图片
      } else {
        // 缓存未命中，验证 session
        const session = await validateSession(c.env.DB, c.env.SESSION_KV, token);
        if (!session) {
          return c.json({ error: '登录已过期' }, 401);
        }

        // 验证是否是图片所有者或管理员
        const isAllowed = session.userId === image.userId || session.role === 'admin';

        // 异步写入缓存（不阻塞响应）
        c.executionCtx.waitUntil(setAuthCache(token, imageId, {
          userId: session.userId!,
          isAllowed
        }));

        if (!isAllowed) {
          return c.json({ error: '无权查看此图片' }, 403);
        }
      }

      // 私有图片不缓存到 CDN
      const object = await getImage(c.env.R2, key);
      if (!object) {
        return c.json({ error: 'File not found' }, 404);
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('X-Auth-Cache', cachedAuth ? 'HIT' : 'MISS');

      return new Response(object.body, { headers });
    }
  }

  // 公开图片或资源文件，使用 CDN 缓存
  const cacheKey = new Request(c.req.url, c.req.raw);
  const cache = caches.default;

  // 检查 CDN 缓存
  let response = await cache.match(cacheKey);
  if (response) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set('X-Cache', 'HIT');
    return cachedResponse;
  }

  // 从 R2 获取
  const object = await getImage(c.env.R2, key);

  if (!object) {
    return c.json({ error: 'File not found' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Cache', 'MISS');
  headers.set('CDN-Cache-Control', 'public, max-age=31536000');

  response = new Response(object.body, { headers });

  // 写入 CDN 缓存（异步，不阻塞响应）
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
});

// ========== 认证 API ==========
app.post('/api/auth/register',
  rateLimit(3, 5 * 60 * 1000),
  zValidator('json', registerSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: getFirstError(result.error) }, 400);
    }
  }),
  async (c) => {
    try {
      const { username, password } = c.req.valid('json');

      const result = await register(c.env.DB, c.env.SESSION_KV, username, password);
      if ('error' in result) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({
        success: true,
        token: result.token,
        user: result.user,
        expiresAt: result.expiresAt
      });
    } catch (error) {
      console.error('Register error:', error);
      return c.json({ error: '注册失败，请稍后重试' }, 500);
    }
  }
);

app.post('/api/auth/login',
  rateLimit(5, 60 * 1000),
  zValidator('json', loginSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: getFirstError(result.error) }, 400);
    }
  }),
  async (c) => {
    try {
      const { username, password } = c.req.valid('json');

      const result = await login(
        c.env.DB,
        c.env.SESSION_KV,
        username,
        password,
        c.env.ADMIN_USERNAME,
        c.env.ADMIN_PASSWORD
      );

      if (!result) {
        return c.json({ error: '用户名或密码错误' }, 401);
      }

      return c.json({
        success: true,
        token: result.token,
        user: result.user,
        expiresAt: result.expiresAt
      });
    } catch (error) {
      console.error('Login error:', error);
      return c.json({ error: '登录失败，请稍后重试' }, 500);
    }
  }
);

app.post('/api/auth/logout', authMiddleware, async (c) => {
  const token = extractToken(c.req.header('Authorization') || null)!;
  await logout(c.env.DB, c.env.SESSION_KV, token);
  return c.json({ success: true });
});

app.get('/api/auth/verify', authMiddleware, async (c) => {
  const user = c.get('user');
  return c.json({
    success: true,
    user: {
      id: user.userId,
      username: user.username,
      role: user.role
    }
  });
});

app.post('/api/auth/change-password',
  authMiddleware,
  zValidator('json', changePasswordSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: getFirstError(result.error) }, 400);
    }
  }),
  async (c) => {
    try {
      const user = c.get('user');
      const { oldPassword, newPassword } = c.req.valid('json');

      if (user.role === 'admin' && !user.userId) {
        return c.json({ error: '管理员账户请通过环境变量修改密码' }, 400);
      }

      const result = await changePassword(c.env.DB, user.userId!, oldPassword, newPassword);
      if ('error' in result) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ success: true, message: '密码修改成功' });
    } catch (error) {
      console.error('Change password error:', error);
      return c.json({ error: '密码修改失败，请稍后重试' }, 500);
    }
  }
);

// ========== 标签 API ==========
app.get('/api/tags', async (c) => {
  try {
    const tags = await tagDb.getAll(c.env.DB);
    return c.json(tags);
  } catch (error) {
    console.error('Get tags error:', error);
    return c.json({ error: '获取标签失败' }, 500);
  }
});

app.post('/api/tags', adminMiddleware, async (c) => {
  try {
    let tagData = await c.req.json();

    // 兼容前端格式
    if (tagData.name && typeof tagData.name === 'object') {
      tagData = tagData.name;
    }

    const { name, color, id } = tagData;
    if (!name) {
      return c.json({ error: '标签名称不能为空' }, 400);
    }

    const tag = await tagDb.create(c.env.DB, { id, name, color });
    return c.json(tag);
  } catch (error) {
    console.error('Create tag error:', error);
    return c.json({ error: '创建标签失败' }, 500);
  }
});

app.put('/api/tags/:id', adminMiddleware, async (c) => {
  try {
    const { name, color } = await c.req.json();
    if (!name) {
      return c.json({ error: '标签名称不能为空' }, 400);
    }

    const tag = await tagDb.update(c.env.DB, c.req.param('id'), { name, color });
    if (!tag) {
      return c.json({ error: '标签不存在' }, 404);
    }
    return c.json(tag);
  } catch (error) {
    console.error('Update tag error:', error);
    return c.json({ error: '更新标签失败' }, 500);
  }
});

app.delete('/api/tags/:id', adminMiddleware, async (c) => {
  try {
    const deleted = await tagDb.delete(c.env.DB, c.req.param('id'));
    if (!deleted) {
      return c.json({ error: '标签不存在' }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    console.error('Delete tag error:', error);
    return c.json({ error: '删除标签失败' }, 500);
  }
});

// ========== 订阅与支付 API ==========

// 获取用户配额信息
app.get('/api/user/quota', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    if (!user.userId) {
      return c.json({ error: '用户未登录' }, 401);
    }

    const quota = await userDb.getQuota(c.env.DB, user.userId);
    if (!quota) {
      return c.json({ error: '用户不存在' }, 404);
    }

    return c.json({ success: true, ...quota });
  } catch (error) {
    console.error('Get quota error:', error);
    return c.json({ error: '获取配额失败' }, 500);
  }
});

// 获取订阅状态
app.get('/api/subscription/status', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    if (!user.userId) {
      return c.json({ error: '用户未登录' }, 401);
    }

    const status = await getSubscriptionStatus(c.env.DB, user.userId);
    return c.json({ success: true, ...status });
  } catch (error) {
    console.error('Get subscription status error:', error);
    return c.json({ error: '获取订阅状态失败' }, 500);
  }
});

// 获取价格列表
app.get('/api/subscription/prices', async (c) => {
  return c.json({
    success: true,
    prices: TIER_PRICES
  });
});

// 创建 Checkout Session
app.post('/api/subscription/checkout', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    if (!user.userId) {
      return c.json({ error: '用户未登录' }, 401);
    }

    const { priceId, email } = await c.req.json();
    if (!priceId || !email) {
      return c.json({ error: '缺少必要参数' }, 400);
    }

    const origin = c.req.header('origin') || 'https://glass.lyrai.eu';
    const successUrl = `${origin}/settings?subscription=success`;
    const cancelUrl = `${origin}/settings?subscription=cancelled`;

    const session = await createCheckoutSession(
      c.env.DB,
      c.env.STRIPE_SECRET_KEY,
      user.userId,
      email,
      priceId,
      successUrl,
      cancelUrl
    );

    return c.json({ success: true, ...session });
  } catch (error: any) {
    console.error('Create checkout session error:', error);
    return c.json({ error: error.message || '创建支付会话失败' }, 500);
  }
});

// 创建客户门户 Session
app.post('/api/subscription/portal', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    if (!user.userId) {
      return c.json({ error: '用户未登录' }, 401);
    }

    const origin = c.req.header('origin') || 'https://glass.lyrai.eu';
    const returnUrl = `${origin}/settings`;

    const session = await createPortalSession(
      c.env.DB,
      c.env.STRIPE_SECRET_KEY,
      user.userId,
      returnUrl
    );

    return c.json({ success: true, ...session });
  } catch (error: any) {
    console.error('Create portal session error:', error);
    return c.json({ error: error.message || '创建管理门户失败' }, 500);
  }
});

// Stripe Webhook
app.post('/api/webhooks/stripe', async (c) => {
  try {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: 'Missing signature' }, 400);
    }

    const payload = await c.req.text();

    // 验证签名
    const isValid = await verifyWebhookSignature(
      payload,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );

    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 400);
    }

    const event = JSON.parse(payload);
    const result = await handleWebhookEvent(c.env.DB, event);

    return c.json(result);
  } catch (error: any) {
    console.error('Webhook error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// ========== 模板 API ==========
app.get('/api/templates', async (c) => {
  try {
    const tag = c.req.query('tag');
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '12', 10);

    const result = await templateDb.getAll(c.env.DB, { tagFilter: tag, page, limit });
    return c.json(result);
  } catch (error) {
    console.error('Get templates error:', error);
    return c.json({ error: '获取模板失败' }, 500);
  }
});

app.get('/api/templates/:id', async (c) => {
  try {
    const template = await templateDb.getById(c.env.DB, c.req.param('id'));
    if (!template) {
      return c.json({ error: '模板不存在' }, 404);
    }
    return c.json(template);
  } catch (error) {
    console.error('Get template error:', error);
    return c.json({ error: '获取模板失败' }, 500);
  }
});

app.post('/api/templates', adminMiddleware, async (c) => {
  try {
    let { id, name, description, imageUrl, prompt, malePrompt, femalePrompt, defaultGender, tags, variables } = await c.req.json();

    if (!imageUrl && !prompt) {
      return c.json({ error: '至少需要提供 imageUrl 或 prompt' }, 400);
    }

    // 如果是 base64 图片，保存到 R2
    if (imageUrl && (imageUrl.startsWith('data:image/') || imageUrl.length > 1000)) {
      const assetName = name || 'template';
      const result = await saveAsset(c.env.R2, imageUrl, assetName);
      imageUrl = result.url;
    }

    const template = await templateDb.create(c.env.DB, {
      id: id || `tpl_${Date.now()}`,
      name: name || '新模板',
      description: description || '',
      imageUrl: imageUrl || '',
      prompt: prompt || '',
      malePrompt: malePrompt || null,
      femalePrompt: femalePrompt || null,
      defaultGender: defaultGender || 'female',
      tags: tags || [],
      variables: variables || []
    });

    return c.json(template);
  } catch (error) {
    console.error('Create template error:', error);
    return c.json({ error: '创建模板失败' }, 500);
  }
});

app.put('/api/templates/:id', adminMiddleware, async (c) => {
  try {
    const updates = await c.req.json();
    const id = c.req.param('id');

    // 获取当前模板信息，以便后续对比图片 URL
    const currentTemplate = await templateDb.getById(c.env.DB, id);
    if (!currentTemplate) {
      return c.json({ error: '模板不存在' }, 404);
    }

    let oldImageUrl = currentTemplate.imageUrl;

    // 如果更新包含大图片，先上传到 R2
    if (updates.imageUrl && (updates.imageUrl.startsWith('data:image/') || updates.imageUrl.length > 1000)) {
      const assetName = updates.name || `template_${id}`;
      const result = await saveAsset(c.env.R2, updates.imageUrl, assetName);
      updates.imageUrl = result.url;
    }

    const updated = await templateDb.update(c.env.DB, id, updates);
    if (!updated) {
      return c.json({ error: '模板更新失败' }, 500); // Should not happen if getById succeeded
    }

    // 检查图片是否已更改，如果是，则删除旧图片
    // 条件：
    // 1. 旧图存在 (oldImageUrl)
    // 2. 新图已上传 (updates.imageUrl)
    // 3. URLs 不同
    if (oldImageUrl && updates.imageUrl && oldImageUrl !== updates.imageUrl) {
      console.log(`[Template Update] Image replaced. Deleting old image: ${oldImageUrl}`);
      // 异步删除旧图，不阻塞响应
      c.executionCtx.waitUntil(deleteAsset(c.env.R2, oldImageUrl));
    }

    return c.json(updated);
  } catch (error: any) {
    console.error('Update template error:', error);
    // 捕获 D1 大小限制错误
    if (error.message && error.message.includes('SQLITE_TOOBIG')) {
      return c.json({ error: '图片过大，请使用压缩后的图片' }, 400);
    }
    return c.json({ error: '更新模板失败' }, 500);
  }
});

app.delete('/api/templates/:id', adminMiddleware, async (c) => {
  try {
    const template = await templateDb.getById(c.env.DB, c.req.param('id'));
    if (!template) {
      return c.json({ error: '模板不存在' }, 404);
    }

    // 删除模板图片
    if (template.imageUrl) {
      await deleteAsset(c.env.R2, template.imageUrl);
    }

    const deleted = await templateDb.delete(c.env.DB, c.req.param('id'));
    if (!deleted) {
      return c.json({ error: '删除失败' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete template error:', error);
    return c.json({ error: '删除模板失败' }, 500);
  }
});

app.post('/api/admin/cleanup-orphans', adminMiddleware, async (c) => {
  try {
    const result = await cleanupOrphanedAssets(c.env.R2, c.env.DB);
    return c.json(result);
  } catch (error: any) {
    console.error('Cleanup orphans error:', error);
    return c.json({ error: error.message || '清理失败' }, 500);
  }
});

// ========== 管理仪表盘 API ==========
app.get('/api/admin/dashboard/stats', adminMiddleware, async (c) => {
  try {
    const [totalUsers, totalGenerations, totalTemplates, queueStats] = await Promise.all([
      statsDb.getTotalUsers(c.env.DB),
      statsDb.getTotalGenerations(c.env.DB),
      statsDb.getTotalTemplates(c.env.DB),
      taskDb.getQueueStats(c.env.DB)
    ]);

    return c.json({
      success: true,
      stats: {
        totalUsers,
        totalGenerations,
        totalTemplates,
        queueStats
      }
    });
  } catch (error: any) {
    console.error('Dashboard stats error:', error);
    return c.json({ error: error.message || '获取统计失败' }, 500);
  }
});

app.get('/api/admin/dashboard/popular-templates', adminMiddleware, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10');
    const templates = await statsDb.getPopularTemplates(c.env.DB, limit);
    return c.json({ success: true, templates });
  } catch (error: any) {
    console.error('Popular templates error:', error);
    return c.json({ error: error.message || '获取热门模板失败' }, 500);
  }
});

app.get('/api/admin/dashboard/activity', adminMiddleware, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const activity = await statsDb.getRecentActivity(c.env.DB, limit);
    return c.json({ success: true, activity });
  } catch (error: any) {
    console.error('Recent activity error:', error);
    return c.json({ error: error.message || '获取最近活动失败' }, 500);
  }
});

app.get('/api/admin/dashboard/trends', adminMiddleware, async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '7');
    const [dailyStats, userGrowth, generationsByType] = await Promise.all([
      statsDb.getDailyStats(c.env.DB, days),
      statsDb.getUserGrowth(c.env.DB, days),
      statsDb.getGenerationsByType(c.env.DB)
    ]);

    return c.json({
      success: true,
      trends: {
        dailyStats,
        userGrowth,
        generationsByType
      }
    });
  } catch (error: any) {
    console.error('Dashboard trends error:', error);
    return c.json({ error: error.message || '获取趋势数据失败' }, 500);
  }
});

// ========== AI 生成 API ==========
app.post('/api/generate/eyewear', rateLimit(10, 60 * 1000), authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { imageBase64, size, modelConfig } = await c.req.json();

    if (!imageBase64 || !modelConfig) {
      return c.json({ error: '缺少必要参数' }, 400);
    }

    const result = await generateEyewearImage(c.env.GEMINI_API_KEY, imageBase64, size || '1K', modelConfig);

    // 保存图片到 R2
    const imageId = crypto.randomUUID();
    const { url, thumbnailUrl } = await saveImage(c.env.R2, result, user.userId || 0, imageId);

    // 保存记录
    await imageDb.save(c.env.DB, {
      id: imageId,
      url,
      thumbnailUrl,
      type: 'eyewear',
      config: modelConfig
    }, user.userId);

    return c.json({ success: true, imageUrl: url, thumbnailUrl });
  } catch (error: any) {
    console.error('Generate eyewear error:', error);
    return c.json({ error: error.message || '生成失败' }, 500);
  }
});

app.post('/api/generate/poster', rateLimit(10, 60 * 1000), authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { imageBase64, config, size, aspectRatio } = await c.req.json();

    if (!imageBase64 || !config) {
      return c.json({ error: '缺少必要参数' }, 400);
    }

    const result = await generatePosterImage(c.env.GEMINI_API_KEY, imageBase64, config, size || '1K', aspectRatio);

    const imageId = crypto.randomUUID();
    const { url, thumbnailUrl } = await saveImage(c.env.R2, result, user.userId || 0, imageId);

    await imageDb.save(c.env.DB, {
      id: imageId,
      url,
      thumbnailUrl,
      type: 'poster',
      config
    }, user.userId);

    return c.json({ success: true, imageUrl: url, thumbnailUrl });
  } catch (error: any) {
    console.error('Generate poster error:', error);
    return c.json({ error: error.message || '生成失败' }, 500);
  }
});

app.post('/api/generate/template', rateLimit(10, 60 * 1000), authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { imageBase64, templateId, aspectRatio, variableValues, customPrompt, parentImageId } = await c.req.json();

    if (!imageBase64) {
      return c.json({ error: '缺少必要参数(imageBase64)' }, 400);
    }

    let finalPrompt: string;
    let templateName = '自定义';

    if (customPrompt) {
      finalPrompt = customPrompt;
    } else if (templateId && templateId !== 'custom') {
      const template = await templateDb.getById(c.env.DB, templateId);
      if (!template) {
        return c.json({ error: '模板不存在' }, 404);
      }
      templateName = template.name;

      finalPrompt = template.prompt;
      if (variableValues && typeof variableValues === 'object') {
        for (const [key, value] of Object.entries(variableValues)) {
          finalPrompt = finalPrompt.replace(new RegExp(`{{${key}}}`, 'g'), value as string);
        }
      }
    } else {
      return c.json({ error: '缺少必要参数(customPrompt 或 templateId)' }, 400);
    }

    const result = await generateFromTemplate(c.env.GEMINI_API_KEY, imageBase64, finalPrompt, aspectRatio || '3:4');

    const imageId = crypto.randomUUID();
    const { url, thumbnailUrl } = await saveImage(c.env.R2, result, user.userId || 0, imageId);

    await imageDb.save(c.env.DB, {
      id: imageId,
      url,
      thumbnailUrl,
      type: 'template',
      config: { templateId, templateName, variableValues, customPrompt: !!customPrompt, parentImageId },
      prompt: finalPrompt
    }, user.userId, parentImageId);

    await promptHistoryDb.save(c.env.DB, user.userId || 0, finalPrompt, templateId !== 'custom' ? templateId : null, variableValues || {}, true);

    return c.json({ success: true, imageUrl: url, thumbnailUrl, imageId, parentImageId });
  } catch (error: any) {
    console.error('Generate from template error:', error);
    return c.json({ error: error.message || '模板生成失败' }, 500);
  }
});

app.post('/api/generate/suggestions', async (c) => {
  try {
    const { mode, imageBase64 } = await c.req.json();
    const suggestions = await getPromptSuggestions(c.env.GEMINI_API_KEY, mode, imageBase64);
    return c.json({ success: true, suggestions });
  } catch (error) {
    console.error('Get suggestions error:', error);
    return c.json({ error: '获取建议失败' }, 500);
  }
});

app.post('/api/generate/optimize-prompt', adminMiddleware, async (c) => {
  try {
    const { prompt } = await c.req.json();
    if (!prompt || prompt.trim().length === 0) {
      return c.json({ error: '请输入需要优化的提示词' }, 400);
    }
    const optimized = await optimizePrompt(c.env.GEMINI_API_KEY, prompt);
    return c.json({ success: true, optimizedPrompt: optimized });
  } catch (error: any) {
    console.error('Optimize prompt error:', error);
    return c.json({ error: error.message || '优化提示词失败' }, 500);
  }
});

// ========== 用户数据 API ==========
app.get('/api/user/history', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const view = c.req.query('view');
    const cursor = c.req.query('cursor') || undefined;
    const limit = parseInt(c.req.query('limit') || '50', 10);

    let result;
    if (view === 'all' && user.role === 'admin') {
      result = await imageDb.getByUserId(c.env.DB, null, { cursor, limit: Math.min(limit, 100) });
    } else {
      result = await imageDb.getByUserId(c.env.DB, user.userId, { cursor, limit: Math.min(limit, 50) });
    }

    return c.json({
      success: true,
      images: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore
    });
  } catch (error) {
    console.error('Get history error:', error);
    return c.json({ error: '获取历史记录失败' }, 500);
  }
});

app.delete('/api/user/history/:imageId', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const image = await imageDb.getById(c.env.DB, c.req.param('imageId'));

    if (!image) {
      return c.json({ error: '图片不存在' }, 404);
    }

    if (image.userId !== user.userId && user.role !== 'admin') {
      return c.json({ error: '无权删除此图片' }, 403);
    }

    await deleteImage(c.env.R2, image.url);
    // 同时删除缩略图
    if (image.thumbnailUrl) {
      await deleteImage(c.env.R2, image.thumbnailUrl);
    }
    await imageDb.delete(c.env.DB, c.req.param('imageId'));

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete image error:', error);
    return c.json({ error: '删除图片失败' }, 500);
  }
});

// ========== 缩略图上传 ==========
app.post('/api/user/history/:imageId/thumbnail', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const imageId = c.req.param('imageId');
    const { thumbnailData } = await c.req.json();

    if (!thumbnailData) {
      return c.json({ error: 'Missing thumbnailData' }, 400);
    }

    const image = await imageDb.getById(c.env.DB, imageId);
    if (!image) {
      return c.json({ error: 'Image not found' }, 404);
    }
    if (image.userId !== user.userId && user.role !== 'admin') {
      return c.json({ error: 'Unauthorized' }, 403);
    }

    const thumbnailUrl = await saveThumbnail(
      c.env.R2, thumbnailData, user.userId || 0, imageId
    );

    await imageDb.updateThumbnail(c.env.DB, imageId, thumbnailUrl, user.userId!);

    return c.json({ success: true, thumbnailUrl });
  } catch (error: any) {
    console.error('Upload thumbnail error:', error);
    return c.json({ error: error.message || 'Thumbnail upload failed' }, 500);
  }
});

// ========== 社区画廊 API ==========
app.get('/api/gallery/public', async (c) => {
  try {
    const cursor = c.req.query('cursor') || undefined;
    const limit = parseInt(c.req.query('limit') || '50', 10);

    const result = await imageDb.getPublicImages(c.env.DB, {
      cursor,
      limit: Math.min(limit, 100) // 最大 100 条
    });

    return c.json({
      success: true,
      images: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore
    });
  } catch (error) {
    console.error('Get public gallery error:', error);
    return c.json({ error: '获取社区作品失败' }, 500);
  }
});

app.post('/api/user/history/:imageId/share', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { isPublic } = await c.req.json();

    if (typeof isPublic !== 'boolean') {
      return c.json({ error: '参数错误' }, 400);
    }

    const result = await imageDb.setPublic(c.env.DB, c.req.param('imageId'), isPublic, user.userId!);

    if (!result.success) {
      return c.json({ error: result.error || '操作失败' }, 403);
    }

    return c.json({
      success: true,
      message: isPublic ? '作品已分享到社区' : '作品已设为私有'
    });
  } catch (error) {
    console.error('Share image error:', error);
    return c.json({ error: '操作失败' }, 500);
  }
});

// 获取图片的迭代链
app.get('/api/user/history/:imageId/iterations', authMiddleware, async (c) => {
  try {
    const iterations = await imageDb.getIterations(c.env.DB, c.req.param('imageId'));
    return c.json({ success: true, iterations });
  } catch (error) {
    console.error('Get iterations error:', error);
    return c.json({ error: '获取迭代历史失败' }, 500);
  }
});

// ========== 收藏 API ==========
app.get('/api/user/favorites', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const favorites = await favoriteDb.getByUserId(c.env.DB, user.userId!);
    return c.json({ success: true, favorites });
  } catch (error) {
    console.error('Get favorites error:', error);
    return c.json({ error: '获取收藏列表失败' }, 500);
  }
});

app.post('/api/user/favorites/:templateId', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const added = await favoriteDb.add(c.env.DB, user.userId!, c.req.param('templateId'));
    return c.json({ success: true, added });
  } catch (error) {
    console.error('Add favorite error:', error);
    return c.json({ error: '添加收藏失败' }, 500);
  }
});

app.delete('/api/user/favorites/:templateId', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const removed = await favoriteDb.remove(c.env.DB, user.userId!, c.req.param('templateId'));
    return c.json({ success: true, removed });
  } catch (error) {
    console.error('Remove favorite error:', error);
    return c.json({ error: '取消收藏失败' }, 500);
  }
});

app.get('/api/user/favorites/:templateId/check', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const isFavorited = await favoriteDb.isFavorited(c.env.DB, user.userId!, c.req.param('templateId'));
    return c.json({ success: true, isFavorited });
  } catch (error) {
    console.error('Check favorite error:', error);
    return c.json({ error: '检查收藏状态失败' }, 500);
  }
});

// ========== 提示词历史 API ==========
app.get('/api/user/prompt-history', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const successful = c.req.query('successful');
    const history = successful === 'true'
      ? await promptHistoryDb.getSuccessful(c.env.DB, user.userId!)
      : await promptHistoryDb.getByUserId(c.env.DB, user.userId!);
    return c.json({ success: true, history });
  } catch (error) {
    console.error('Get prompt history error:', error);
    return c.json({ error: '获取提示词历史失败' }, 500);
  }
});

app.delete('/api/user/prompt-history/:id', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const deleted = await promptHistoryDb.delete(c.env.DB, parseInt(c.req.param('id')), user.userId!);
    return c.json({ success: true, deleted });
  } catch (error) {
    console.error('Delete prompt history error:', error);
    return c.json({ error: '删除提示词历史失败' }, 500);
  }
});

// ========== 反馈 API ==========
app.post('/api/feedback/:imageId', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { rating } = await c.req.json();
    if (rating !== 1 && rating !== -1) {
      return c.json({ error: '无效的评分值' }, 400);
    }
    await feedbackDb.upsert(c.env.DB, user.userId!, c.req.param('imageId'), rating);
    return c.json({ success: true });
  } catch (error) {
    console.error('Submit feedback error:', error);
    return c.json({ error: '提交反馈失败' }, 500);
  }
});

app.get('/api/feedback/:imageId', async (c) => {
  try {
    const stats = await feedbackDb.getStats(c.env.DB, c.req.param('imageId'));
    return c.json({ success: true, ...stats });
  } catch (error) {
    console.error('Get feedback error:', error);
    return c.json({ error: '获取反馈统计失败' }, 500);
  }
});

app.get('/api/feedback/:imageId/user', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const rating = await feedbackDb.get(c.env.DB, user.userId!, c.req.param('imageId'));
    return c.json({ success: true, rating: rating || 0 });
  } catch (error) {
    console.error('Get user feedback error:', error);
    return c.json({ error: '获取用户反馈失败' }, 500);
  }
});

app.get('/api/templates/:id/stats', async (c) => {
  try {
    const stats = await feedbackDb.getTemplateStats(c.env.DB, c.req.param('id'));
    const favoriteCount = await favoriteDb.getCount(c.env.DB, c.req.param('id'));
    return c.json({ success: true, ...stats, favoriteCount });
  } catch (error) {
    console.error('Get template stats error:', error);
    return c.json({ error: '获取模板统计失败' }, 500);
  }
});

// ========== 任务队列 API ==========
app.post('/api/tasks/generate', rateLimit(10, 60 * 1000), authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { imageBase64, prompt, aspectRatio, templateId, templateName, variableValues, modelConfig, imageQuality, gender } = await c.req.json();

    if (!imageBase64 || (!prompt && !modelConfig)) {
      return c.json({ error: '缺少必要参数' }, 400);
    }

    const userId = user.userId ?? 0;

    // 检查配额
    const quotaResult = await userDb.consumeQuota(c.env.DB, userId, 1);
    if (!quotaResult.success) {
      return c.json({ error: quotaResult.error }, 403);
    }
    const taskId = crypto.randomUUID();
    const task = await taskDb.create(c.env.DB, taskId, userId, 'generate', {
      imageBase64,
      prompt,
      aspectRatio: aspectRatio || '3:4',
      templateId,
      templateName,
      variableValues,
      modelConfig,
      imageQuality,
      gender: gender || 'female'
    });

    const stats = await taskDb.getQueueStats(c.env.DB);

    // 发送到 Cloudflare Queue（如果可用）
    if (c.env.GENERATION_QUEUE) {
      await c.env.GENERATION_QUEUE.send({
        taskId: task.id,
        type: 'generate',
        timestamp: Date.now()
      });
    } else {
      // 回退到直接处理（开发环境或 Queue 未配置）
      c.executionCtx.waitUntil(processTask(c.env, task.id));
    }

    return c.json({
      success: true,
      taskId: task.id,
      status: task.status,
      queuePosition: stats.pending,
      message: '任务已加入队列，可关闭页面，稍后在历史记录中查看结果'
    });
  } catch (error) {
    console.error('Create task error:', error);
    return c.json({ error: '创建任务失败' }, 500);
  }
});

app.post('/api/tasks/batch', rateLimit(3, 60 * 1000), authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { imageBase64, basePrompt, combinations, aspectRatio, templateId, templateName, concurrency: reqConcurrency } = await c.req.json();

    if (!imageBase64 || !combinations || !Array.isArray(combinations)) {
      return c.json({ error: '缺少必要参数' }, 400);
    }

    const userId = user.userId ?? 0;

    // 检查等级的批量限制
    const tierConfig = TIER_CONFIGS[user.tier || 'free'];
    if (combinations.length > tierConfig.batchLimit) {
      return c.json({
        error: `您的等级最多支持${tierConfig.batchLimit}张批量生成，请升级会员或减少数量`
      }, 403);
    }

    // 检查配额（批量任务消耗多个配额）
    const quotaResult = await userDb.consumeQuota(c.env.DB, userId, combinations.length);
    if (!quotaResult.success) {
      return c.json({ error: quotaResult.error }, 403);
    }

    const taskId = crypto.randomUUID();

    // 获取用户指定的并行数（1-5），默认3
    const concurrency = Math.min(5, Math.max(1, reqConcurrency || 3));

    // Create the main batch task
    const task = await taskDb.create(c.env.DB, taskId, userId, 'batch', {
      imageBase64,
      basePrompt,
      combinations,
      aspectRatio: aspectRatio || '3:4',
      templateId,
      templateName,
      concurrency  // 保存并行数设置
    });

    const stats = await taskDb.getQueueStats(c.env.DB);

    // 发送到 Cloudflare Queue（如果可用）
    if (c.env.GENERATION_QUEUE) {
      await c.env.GENERATION_QUEUE.send({
        taskId: task.id,
        type: 'batch',
        timestamp: Date.now()
      });
    } else {
      // 回退到直接处理
      c.executionCtx.waitUntil(processTask(c.env, task.id));
    }

    return c.json({
      success: true,
      taskId: task.id,
      status: task.status,
      queuePosition: stats.pending,
      message: '批量任务已创建，正在后台处理'
    });
  } catch (error) {
    console.error('Create batch task error:', error);
    return c.json({ error: '创建批量任务失败' }, 500);
  }
});

// ========== 产品图生成任务 API ==========
app.post('/api/tasks/product-shot', rateLimit(10, 60 * 1000), authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const { imageBase64, angles, config, concurrency: reqConcurrency } = await c.req.json();

    if (!imageBase64 || !angles || !Array.isArray(angles) || angles.length === 0) {
      return c.json({ error: '缺少必要参数' }, 400);
    }

    // 检查产品摄影功能权限
    const tierConfig = TIER_CONFIGS[user.tier || 'free'];
    if (!tierConfig.features.productShot) {
      return c.json({ error: '产品摄影功能需要 Pro 或 Ultra 会员' }, 403);
    }

    const userId = user.userId ?? 0;

    // 检查配额
    const quotaResult = await userDb.consumeQuota(c.env.DB, userId, angles.length);
    if (!quotaResult.success) {
      return c.json({ error: quotaResult.error }, 403);
    }
    const batchId = crypto.randomUUID();
    const taskIds: string[] = [];

    const taskConfig = {
      backgroundColor: config?.backgroundColor || 'pure_white',
      reflectionEnabled: config?.reflectionEnabled ?? false,  // 默认关闭倒影
      shadowStyle: config?.shadowStyle || 'none',             // 默认无阴影
      outputSize: config?.outputSize || '1K',
      aspectRatio: config?.aspectRatio || '1:1'
    };

    // 获取用户指定的并行数（1-5），默认3
    const concurrency = Math.min(5, Math.max(1, reqConcurrency || 3));

    // 为每个角度创建独立任务
    for (const angle of angles) {
      const taskId = crypto.randomUUID();
      await taskDb.create(c.env.DB, taskId, userId, 'product_shot', {
        imageBase64,
        angle,
        config: taskConfig,
        concurrency
      }, batchId);
      taskIds.push(taskId);
    }

    const stats = await taskDb.getQueueStats(c.env.DB);

    // 发送所有任务到 Queue（如果可用）
    if (c.env.GENERATION_QUEUE) {
      await Promise.all(taskIds.map(taskId =>
        c.env.GENERATION_QUEUE.send({
          taskId,
          type: 'product_shot',
          timestamp: Date.now()
        })
      ));
    } else {
      // 回退到直接处理
      c.executionCtx.waitUntil(processBatchTasks(c.env, batchId, concurrency));
    }

    return c.json({
      success: true,
      batchId,
      taskIds,
      status: 'pending',
      queuePosition: stats.pending,
      totalImages: angles.length,
      message: `正在生成 ${angles.length} 张产品图`
    });
  } catch (error) {
    console.error('Create product shot batch error:', error);
    return c.json({ error: '创建产品图任务失败' }, 500);
  }
});

// 获取批次状态
app.get('/api/tasks/batch/:batchId', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const batchId = c.req.param('batchId');

    const tasks = await taskDb.getByBatchId(c.env.DB, batchId);

    if (tasks.length === 0) {
      return c.json({ error: '批次不存在' }, 404);
    }

    // 验证所有任务属于当前用户
    const userId = user.userId ?? 0;
    if (tasks[0].userId !== userId) {
      return c.json({ error: '无权访问此批次' }, 403);
    }

    const progress = await taskDb.getBatchProgress(c.env.DB, batchId);

    // 聚合已完成任务的结果
    const results = tasks
      .filter(t => t.status === 'completed' && t.outputData)
      .map(t => ({
        angle: t.outputData?.angle || t.inputData.angle,
        imageUrl: t.outputData?.imageUrl,
        thumbnailUrl: t.outputData?.thumbnailUrl,
        imageId: t.outputData?.imageId
      }));

    return c.json({
      success: true,
      batchId,
      progress,
      tasks: tasks.map(t => ({
        id: t.id,
        angle: t.inputData.angle,
        status: t.status,
        errorMessage: t.errorMessage
      })),
      results,
      isCompleted: progress.pending === 0 && progress.processing === 0
    });
  } catch (error) {
    console.error('Get batch error:', error);
    return c.json({ error: '获取批次状态失败' }, 500);
  }
});

app.get('/api/tasks/:taskId', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const task = await taskDb.getById(c.env.DB, c.req.param('taskId'));

    if (!task) {
      return c.json({ error: '任务不存在' }, 404);
    }

    const userId = user.userId ?? 0;
    if (task.userId !== userId) {
      return c.json({ error: '无权访问此任务' }, 403);
    }

    return c.json({
      success: true,
      task: {
        id: task.id,
        type: task.type,
        status: task.status,
        progress: task.progress,
        outputData: task.outputData,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt
      }
    });
  } catch (error) {
    console.error('Get task error:', error);
    return c.json({ error: '获取任务状态失败' }, 500);
  }
});

app.get('/api/tasks', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const active = c.req.query('active');
    const completed = c.req.query('completed');
    const userId = user.userId ?? 0;

    let tasks;
    if (active === 'true') {
      tasks = await taskDb.getActiveTasks(c.env.DB, userId);
    } else if (completed === 'true') {
      tasks = await taskDb.getCompletedTasks(c.env.DB, userId, 50);
    } else {
      tasks = await taskDb.getByUserId(c.env.DB, userId, 50);
    }

    return c.json({ success: true, tasks });
  } catch (error) {
    console.error('Get tasks error:', error);
    return c.json({ error: '获取任务列表失败' }, 500);
  }
});

// 取消任务
app.post('/api/tasks/:taskId/cancel', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('taskId');
    const userId = user.userId ?? 0;

    const result = await taskDb.cancel(c.env.DB, taskId, userId);

    if (!result.success) {
      return c.json({ success: false, error: result.message }, 400);
    }

    return c.json({ success: true, message: result.message });
  } catch (error) {
    console.error('Cancel task error:', error);
    return c.json({ error: '取消任务失败' }, 500);
  }
});

app.get('/api/tasks/queue/stats', async (c) => {
  try {
    const stats = await taskDb.getQueueStats(c.env.DB);
    return c.json({
      success: true,
      queue: stats,
      processor: {
        isRunning: true,
        activeWorkers: stats.processing,
        maxWorkers: 3
      }
    });
  } catch (error) {
    console.error('Get queue stats error:', error);
    return c.json({ error: '获取队列统计失败' }, 500);
  }
});

// ========== 管理员资源 API ==========
app.post('/api/admin/assets', adminMiddleware, async (c) => {
  try {
    const { name, imageData, type } = await c.req.json();
    if (!name || !imageData) {
      return c.json({ error: 'Missing name or imageData' }, 400);
    }

    const result = await saveAsset(c.env.R2, imageData, name);

    const asset = await assetDb.add(c.env.DB, {
      id: result.id,
      name,
      url: result.url,
      thumbnailUrl: result.thumbnailUrl,
      type: type || 'image'
    });

    return c.json({ success: true, asset });
  } catch (error) {
    console.error('Upload asset error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

app.post('/api/admin/migrate-legacy-images', adminMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const urls = body.urls;

    if (!urls || !Array.isArray(urls)) {
      return c.json({ error: 'Invalid urls array' }, 400);
    }

    const results = [];
    for (const url of urls) {
      if (!url) continue;
      try {
        console.log(`Migrating: ${url}`);
        const resp = await fetch(url);
        if (!resp.ok) {
          results.push({ url, success: false, error: `Fetch status ${resp.status}` });
          continue;
        }

        const contentType = resp.headers.get('content-type') || 'image/png';
        const buffer = await resp.arrayBuffer();

        // Key: assets/filename.png
        // url: https://...r2.dev/assets/foo.png
        let key = '';
        if (url.includes('/assets/')) {
          key = 'assets/' + url.split('/assets/')[1];
        } else {
          key = 'assets/' + url.split('/').pop();
        }

        // Remove query params if any
        key = key.split('?')[0];

        await c.env.R2.put(key, buffer, {
          httpMetadata: { contentType }
        });

        results.push({ url, key, success: true });
      } catch (err: any) {
        console.error(`Migration error for ${url}:`, err);
        results.push({ url, success: false, error: err.message });
      }
    }
    return c.json({ success: true, processed: results.length, results });
  } catch (e: any) {
    console.error('Migration API error:', e);
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/admin/assets', adminMiddleware, async (c) => {
  try {
    const assets = await assetDb.getAll(c.env.DB);
    return c.json({ success: true, assets });
  } catch (error) {
    console.error('Get assets error:', error);
    return c.json({ error: 'Failed to get assets' }, 500);
  }
});

app.delete('/api/admin/assets/:id', adminMiddleware, async (c) => {
  try {
    const asset = await assetDb.getById(c.env.DB, c.req.param('id'));
    if (!asset) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    await deleteAsset(c.env.R2, asset.url as string);
    await assetDb.delete(c.env.DB, c.req.param('id'));
    return c.json({ success: true });
  } catch (error) {
    console.error('Delete asset error:', error);
    return c.json({ error: 'Failed to delete asset' }, 500);
  }
});

// ========== 健康检查 ==========
app.get('/api/health', async (c) => {
  const stats = await taskDb.getQueueStats(c.env.DB);
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasApiKey: !!c.env.GEMINI_API_KEY,
    taskProcessor: 'running',
    queueStats: stats
  });
});

// ========== Cron 触发器（定时清理） ==========
// 导出 Durable Object 类
export { TaskMonitor } from './do/TaskMonitor';

// ========== WebSocket API ==========
app.get('/api/ws/task/:taskId', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426);
  }

  const taskId = c.req.param('taskId');
  const id = c.env.TASK_MONITOR.idFromName(taskId);
  const stub = c.env.TASK_MONITOR.get(id);

  return stub.fetch(c.req.raw);
});


export default {
  fetch: app.fetch,

  // Queue 消费者：处理生成任务
  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext) {
    console.log(`[Queue] Processing batch of ${batch.messages.length} messages`);

    for (const message of batch.messages) {
      const { taskId, type } = message.body;
      console.log(`[Queue] Processing task ${taskId} (type: ${type})`);

      try {
        // 处理任务
        await processTask(env, taskId);

        // 确认消息已处理
        message.ack();
        console.log(`[Queue] Task ${taskId} completed successfully`);
      } catch (error: any) {
        console.error(`[Queue] Task ${taskId} failed:`, error);

        // 更新任务状态为失败
        await taskDb.fail(env.DB, taskId, error.message || '处理失败');

        // 如果重试次数未用完，重新入队（通过不 ack 实现）
        // Cloudflare Queues 会自动重试
        if (message.attempts < 3) {
          message.retry({ delaySeconds: Math.pow(2, message.attempts) * 10 }); // 指数退避：10s, 20s, 40s
        } else {
          // 超过重试次数，移到死信队列
          message.ack();
          console.error(`[Queue] Task ${taskId} moved to DLQ after ${message.attempts} attempts`);
        }
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const isDailyCleanup = event.cron === '0 3 * * *';

    // Always: reset stuck tasks and process pending tasks (runs every 5 min)
    const resetTasks = await taskDb.resetStuckTasks(env.DB);
    if (resetTasks > 0) {
      console.log(`[Cron] Reset ${resetTasks} stuck tasks`);
    }

    // 如果 Queue 未配置，继续使用轮询处理
    if (!env.GENERATION_QUEUE) {
      const processedCount = await processPendingTasks(env);
      if (processedCount > 0) {
        console.log(`[Cron] Processed ${processedCount} pending tasks`);
      }
    }

    // Daily cleanup only (runs at 3 AM)
    if (isDailyCleanup) {
      console.log('[Cron] Running daily cleanup...');

      const cleanedSessions = await sessionDb.cleanup(env.DB);
      console.log(`[Cron] Cleaned ${cleanedSessions} expired sessions`);

      const cleanedImages = await cleanupOldImages(env.R2, env.DB, 30);
      console.log(`[Cron] Cleaned ${cleanedImages} expired images`);

      const cleanedTasks = await taskDb.cleanup(env.DB, 7);
      console.log(`[Cron] Cleaned ${cleanedTasks} expired tasks`);
    }
  }
};
