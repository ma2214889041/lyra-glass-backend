import type { D1Database } from '@cloudflare/workers-types';
import { sessionDb, userDb } from './db';
import type { Session } from './types';

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
  username: string,
  password: string
) {
  // 检查用户名是否已存在
  if (await userDb.usernameExists(db, username)) {
    return { error: '用户名已存在' };
  }

  // 用户名验证
  if (username.length < 3 || username.length > 20) {
    return { error: '用户名长度需在3-20字符之间' };
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
    return { error: '用户名只能包含字母、数字、下划线和中文' };
  }

  // 密码验证
  if (password.length < 6) {
    return { error: '密码长度至少6位' };
  }

  // 创建用户
  const passwordHash = await hashPassword(password);
  const user = await userDb.create(db, username, passwordHash);

  // 自动登录
  const token = generateToken();
  const session = await sessionDb.create(db, token, username, 24 * 7, user.id, 'user');

  return {
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role },
    expiresAt: session.expiresAt
  };
}

/**
 * 普通用户登录
 */
export async function userLogin(
  db: D1Database,
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

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role },
    expiresAt: session.expiresAt
  };
}

/**
 * 管理员登录
 */
export async function adminLogin(
  db: D1Database,
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

  return {
    token,
    user: { id: null, username, role: 'admin' },
    expiresAt: session.expiresAt
  };
}

/**
 * 统一登录（先尝试普通用户，再尝试管理员）
 */
export async function login(
  db: D1Database,
  username: string,
  password: string,
  adminUsername: string,
  adminPassword: string
) {
  // 先尝试普通用户登录
  const userResult = await userLogin(db, username, password);
  if (userResult) return userResult;

  // 再尝试管理员登录
  const adminResult = await adminLogin(db, username, password, adminUsername, adminPassword);
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

  // 验证新密码
  if (newPassword.length < 6) {
    return { error: '新密码长度至少6位' };
  }

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
export async function logout(db: D1Database, token: string): Promise<boolean> {
  return sessionDb.delete(db, token);
}

/**
 * 验证 session
 */
export async function validateSession(db: D1Database, token: string): Promise<Session | null> {
  return sessionDb.validate(db, token);
}

/**
 * 从请求头中提取 token
 */
export function extractToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
