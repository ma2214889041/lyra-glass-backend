import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { sessionDb, userDb } from './db';
import type { Session, UserTier } from './types';

// KV 缓存 TTL（与 session 过期时间一致）
const SESSION_KV_TTL = 7 * 24 * 60 * 60; // 7天（秒）

/**
 * 生成随机 token (使用 Web Crypto API)
 */
export function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 密码哈希 (使用 PBKDF2 替代 scrypt)
 * Workers 支持 PBKDF2，但不支持 scrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  const derivedArray = new Uint8Array(derivedBits);
  const saltHex = Array.from(salt, b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(derivedArray, b => b.toString(16).padStart(2, '0')).join('');

  return `${saltHex}:${hashHex}`;
}

/**
 * 验证密码
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, storedHashHex] = storedHash.split(':');

  // 将 hex 转换回 Uint8Array
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  const derivedArray = new Uint8Array(derivedBits);
  const derivedHex = Array.from(derivedArray, b => b.toString(16).padStart(2, '0')).join('');

  // 使用时间安全的比较
  return timingSafeEqual(derivedHex, storedHashHex);
}

/**
 * 时间安全的字符串比较
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * 验证管理员凭据
 */
export function validateAdminCredentials(
  username: string,
  password: string,
  adminUsername: string,
  adminPassword: string
): boolean {
  return username === adminUsername && password === adminPassword;
}

/**
 * 用户注册
 */
export async function register(
  db: D1Database,
  kv: KVNamespace,
  username: string,
  password: string
) {
  // 检查用户名是否已存在
  if (await userDb.usernameExists(db, username)) {
    return { error: '用户名已存在' };
  }

  // Note: Input validation is now handled by Zod middleware in index.ts
  // No need to validate username/password format here

  // 创建用户
  const passwordHash = await hashPassword(password);
  const user = await userDb.create(db, username, passwordHash);

  // 自动登录
  const token = generateToken();
  const session = await sessionDb.create(db, token, username, 24 * 7, user.id, 'user');

  // 写入 KV 缓存
  const sessionData: Session = {
    username,
    userId: user.id,
    role: 'user',
    tier: user.tier,
    expiresAt: session.expiresAt
  };
  await kv.put(`session:${token}`, JSON.stringify(sessionData), {
    expirationTtl: SESSION_KV_TTL
  });

  return {
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role, tier: user.tier },
    expiresAt: session.expiresAt
  };
}

/**
 * 普通用户登录
 */
export async function userLogin(
  db: D1Database,
  kv: KVNamespace,
  username: string,
  password: string
) {
  const user = await userDb.findByUsername(db, username);
  if (!user) return null;

  const isValid = await verifyPassword(password, user.password_hash as string);
  if (!isValid) return null;

  const token = generateToken();
  const session = await sessionDb.create(
    db,
    token,
    username,
    24 * 7,
    user.id as number,
    user.role as string
  );

  // 写入 KV 缓存
  const tier = (user.tier as UserTier) || 'free';
  const sessionData: Session = {
    username,
    userId: user.id as number,
    role: user.role as 'user' | 'admin',
    tier,
    expiresAt: session.expiresAt
  };
  await kv.put(`session:${token}`, JSON.stringify(sessionData), {
    expirationTtl: SESSION_KV_TTL
  });

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      tier
    },
    expiresAt: session.expiresAt
  };
}

/**
 * 管理员登录
 */
export async function adminLogin(
  db: D1Database,
  kv: KVNamespace,
  username: string,
  password: string,
  adminUsername: string,
  adminPassword: string
) {
  if (!validateAdminCredentials(username, password, adminUsername, adminPassword)) {
    return null;
  }

  const token = generateToken();
  const session = await sessionDb.create(db, token, username, 24, null, 'admin');

  // 写入 KV 缓存
  const sessionData: Session = {
    username,
    userId: null,
    role: 'admin',
    tier: 'ultra' as UserTier,
    expiresAt: session.expiresAt
  };
  await kv.put(`session:${token}`, JSON.stringify(sessionData), {
    expirationTtl: 24 * 60 * 60 // 管理员 24 小时
  });

  return {
    token,
    user: { id: null, username, role: 'admin', tier: 'ultra' as UserTier },
    expiresAt: session.expiresAt
  };
}

/**
 * 统一登录（先尝试普通用户，再尝试管理员）
 */
export async function login(
  db: D1Database,
  kv: KVNamespace,
  username: string,
  password: string,
  adminUsername: string,
  adminPassword: string
) {
  // 先尝试普通用户登录
  const userResult = await userLogin(db, kv, username, password);
  if (userResult) return userResult;

  // 再尝试管理员登录
  const adminResult = await adminLogin(db, kv, username, password, adminUsername, adminPassword);
  if (adminResult) return adminResult;

  return null;
}

/**
 * 修改密码
 */
export async function changePassword(
  db: D1Database,
  userId: number,
  oldPassword: string,
  newPassword: string
) {
  const userData = await userDb.findById(db, userId);
  if (!userData) {
    return { error: '用户不存在' };
  }

  const user = await userDb.findByUsername(db, userData.username as string);
  if (!user) {
    return { error: '用户不存在' };
  }

  // 验证旧密码
  const isValid = await verifyPassword(oldPassword, user.password_hash as string);
  if (!isValid) {
    return { error: '当前密码错误' };
  }

  // Note: New password validation is now handled by Zod middleware

  // 更新密码
  const newHash = await hashPassword(newPassword);
  const updated = await userDb.updatePassword(db, userId, newHash);
  if (!updated) {
    return { error: '密码更新失败' };
  }

  return { success: true };
}

/**
 * 登出
 */
export async function logout(db: D1Database, kv: KVNamespace, token: string): Promise<boolean> {
  // 同时从 D1 和 KV 删除
  await kv.delete(`session:${token}`);
  return sessionDb.delete(db, token);
}

/**
 * 验证 session（KV 优先，减少 D1 读取）
 */
export async function validateSession(
  db: D1Database,
  kv: KVNamespace,
  token: string
): Promise<Session | null> {
  const now = Math.floor(Date.now() / 1000);

  // 1. 先查 KV 缓存
  try {
    const cached = await kv.get(`session:${token}`, 'json');
    if (cached) {
      const session = cached as Session;
      // 检查是否过期
      if (session.expiresAt > now) {
        return session;
      }
      // 过期则删除 KV 缓存
      await kv.delete(`session:${token}`);
    }
  } catch (e) {
    // KV 读取失败，继续查 D1
    console.error('KV read error:', e);
  }

  // 2. KV 未命中，查 D1
  const session = await sessionDb.validate(db, token);
  if (!session) return null;

  // 3. 回写 KV（计算剩余 TTL）
  const remainingTtl = session.expiresAt - now;
  if (remainingTtl > 0) {
    try {
      await kv.put(`session:${token}`, JSON.stringify(session), {
        expirationTtl: remainingTtl
      });
    } catch (e) {
      // KV 写入失败，不影响正常流程
      console.error('KV write error:', e);
    }
  }

  return session;
}

/**
 * 从请求头中提取 token
 */
export function extractToken(authHeader: string | null | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
