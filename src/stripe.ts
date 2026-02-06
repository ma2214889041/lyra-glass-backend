/**
 * Stripe 订阅集成模块
 * 处理支付、订阅和 Webhook
 */

import type { D1Database } from '@cloudflare/workers-types';
import { userDb } from './db';
import type { UserTier } from './types';

// Stripe API 基础配置
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

// 价格 ID 到等级的映射（需要在 Stripe Dashboard 创建后更新）
const PRICE_TO_TIER: Record<string, UserTier> = {
  // 月付
  'price_pro_monthly': 'pro',
  'price_ultra_monthly': 'ultra',
  // 年付
  'price_pro_yearly': 'pro',
  'price_ultra_yearly': 'ultra'
};

// 等级到价格的映射
export const TIER_PRICES = {
  pro: {
    monthly: { priceId: 'price_pro_monthly', amount: 29, currency: 'cny' },
    yearly: { priceId: 'price_pro_yearly', amount: 290, currency: 'cny' }
  },
  ultra: {
    monthly: { priceId: 'price_ultra_monthly', amount: 99, currency: 'cny' },
    yearly: { priceId: 'price_ultra_yearly', amount: 990, currency: 'cny' }
  }
};

/**
 * 调用 Stripe API
 */
async function stripeRequest(
  secretKey: string,
  endpoint: string,
  method: string = 'GET',
  body?: Record<string, string>
): Promise<any> {
  const response = await fetch(`${STRIPE_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body ? new URLSearchParams(body).toString() : undefined
  });

  const data = await response.json() as any;
  if (!response.ok) {
    throw new Error(data.error?.message || 'Stripe API error');
  }
  return data;
}

/**
 * 创建或获取 Stripe 客户
 */
export async function getOrCreateCustomer(
  db: D1Database,
  secretKey: string,
  userId: number,
  email: string
): Promise<string> {
  // 检查用户是否已有 Stripe 客户 ID
  const user = await userDb.findById(db, userId);
  if (user?.stripe_customer_id) {
    return user.stripe_customer_id as string;
  }

  // 创建新客户
  const customer = await stripeRequest(secretKey, '/customers', 'POST', {
    email,
    'metadata[userId]': String(userId)
  });

  // 保存客户 ID
  await userDb.updateStripeCustomer(db, userId, customer.id);
  return customer.id;
}

/**
 * 创建 Checkout Session
 */
export async function createCheckoutSession(
  db: D1Database,
  secretKey: string,
  userId: number,
  email: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string
): Promise<{ sessionId: string; url: string }> {
  // 获取或创建客户
  const customerId = await getOrCreateCustomer(db, secretKey, userId, email);

  // 创建 Checkout Session
  const session = await stripeRequest(secretKey, '/checkout/sessions', 'POST', {
    customer: customerId,
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'subscription_data[metadata][userId]': String(userId),
    allow_promotion_codes: 'true'
  });

  return {
    sessionId: session.id,
    url: session.url
  };
}

/**
 * 创建客户门户 Session（用于管理订阅）
 */
export async function createPortalSession(
  db: D1Database,
  secretKey: string,
  userId: number,
  returnUrl: string
): Promise<{ url: string }> {
  const user = await userDb.findById(db, userId);
  if (!user?.stripe_customer_id) {
    throw new Error('用户未订阅');
  }

  const session = await stripeRequest(secretKey, '/billing_portal/sessions', 'POST', {
    customer: user.stripe_customer_id as string,
    return_url: returnUrl
  });

  return { url: session.url };
}

/**
 * 验证 Webhook 签名
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  webhookSecret: string
): Promise<boolean> {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const v1Signature = parts.find(p => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !v1Signature) return false;

  // 检查时间戳（5分钟内有效）
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp)) > 300) return false;

  // 计算预期签名
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return expectedSignature === v1Signature;
}

/**
 * 检查事件是否已处理（防止重复）
 */
async function isEventProcessed(db: D1Database, eventId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').bind(eventId).first();
  return !!row;
}

/**
 * 标记事件已处理
 */
async function markEventProcessed(db: D1Database, eventId: string, eventType: string): Promise<void> {
  await db.prepare('INSERT INTO stripe_events (id, type) VALUES (?, ?)')
    .bind(eventId, eventType).run();
}

/**
 * 处理 Webhook 事件
 */
export async function handleWebhookEvent(
  db: D1Database,
  event: any
): Promise<{ success: boolean; message: string }> {
  const eventId = event.id;
  const eventType = event.type;

  // 检查是否已处理
  if (await isEventProcessed(db, eventId)) {
    return { success: true, message: 'Event already processed' };
  }

  try {
    switch (eventType) {
      case 'checkout.session.completed': {
        // 支付成功，激活订阅
        const session = event.data.object;
        if (session.mode === 'subscription') {
          const subscriptionId = session.subscription;
          const customerId = session.customer;

          // 获取订阅详情
          // 这里需要再次调用 Stripe API 获取订阅的价格信息
          // 但在 webhook 中我们通常通过 subscription 事件处理
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const status = subscription.status;
        const priceId = subscription.items?.data[0]?.price?.id;
        const tier = priceId ? PRICE_TO_TIER[priceId] || 'free' : 'free';
        const endsAt = subscription.current_period_end;

        // 只有 active 或 trialing 状态才激活会员
        if (status === 'active' || status === 'trialing') {
          await userDb.updateSubscription(db, customerId, subscription.id, status, tier, endsAt);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // 订阅取消
        const subscription = event.data.object;
        const customerId = subscription.customer;
        await userDb.cancelSubscription(db, customerId);
        break;
      }

      case 'invoice.payment_failed': {
        // 付款失败
        const invoice = event.data.object;
        const customerId = invoice.customer;
        // 可以发送通知或标记用户
        console.log(`Payment failed for customer ${customerId}`);
        break;
      }

      default:
        // 忽略其他事件
        break;
    }

    // 标记事件已处理
    await markEventProcessed(db, eventId, eventType);
    return { success: true, message: `Processed ${eventType}` };
  } catch (error: any) {
    console.error(`Error processing ${eventType}:`, error);
    return { success: false, message: error.message };
  }
}

/**
 * 获取订阅状态
 */
export async function getSubscriptionStatus(
  db: D1Database,
  userId: number
): Promise<{
  tier: UserTier;
  status: string;
  endsAt: number | null;
  isActive: boolean;
}> {
  const user = await userDb.findById(db, userId);
  if (!user) {
    return { tier: 'free', status: 'none', endsAt: null, isActive: false };
  }

  const tier = (user.tier as UserTier) || 'free';
  const status = (user.subscription_status as string) || 'none';
  const endsAt = user.subscription_ends_at as number | null;
  const isActive = status === 'active' || status === 'trialing';

  return { tier, status, endsAt, isActive };
}
