import type { Context, Next } from 'hono';
import type { Env } from './types';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const limiters = new Map<string, RateLimitEntry>();

// Periodic cleanup to prevent memory leaks
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60_000; // 1 minute

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of limiters) {
    if (now > entry.resetAt) limiters.delete(key);
  }
}

export function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    cleanup();

    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    const entry = limiters.get(key);
    if (entry && now < entry.resetAt) {
      if (entry.count >= maxRequests) {
        return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
      }
      entry.count++;
    } else {
      limiters.set(key, { count: 1, resetAt: now + windowMs });
    }

    await next();
  };
}
