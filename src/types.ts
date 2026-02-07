// Cloudflare Workers 环境绑定类型
export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  SESSION_KV: KVNamespace;
  GENERATION_QUEUE: Queue<QueueMessage>;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  GEMINI_API_KEY: string;
  // Stripe
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  TASK_MONITOR: DurableObjectNamespace;
}


// 用户等级类型
export type UserTier = 'free' | 'pro' | 'ultra';

// 等级配置
export interface TierConfig {
  dailyLimit: number;        // 每日生成次数限制 (-1 = 无限制)
  batchLimit: number;        // 单次批量生成数量
  priority: number;          // 队列优先级
  imageRetentionDays: number; // 图片保存天数 (-1 = 永久)
  features: {
    productShot: boolean;    // 产品摄影模式
    masterMode: boolean;     // 大师级配置
    premiumTemplates: boolean; // 高级模板
  };
}

// 等级配置表
export const TIER_CONFIGS: Record<UserTier, TierConfig> = {
  free: {
    dailyLimit: 5,
    batchLimit: 2,
    priority: 0,
    imageRetentionDays: 7,
    features: {
      productShot: false,
      masterMode: false,
      premiumTemplates: false
    }
  },
  pro: {
    dailyLimit: 50,
    batchLimit: 5,
    priority: 5,
    imageRetentionDays: 30,
    features: {
      productShot: true,
      masterMode: false,
      premiumTemplates: true
    }
  },
  ultra: {
    dailyLimit: -1, // 无限制
    batchLimit: 10,
    priority: 10,
    imageRetentionDays: -1, // 永久
    features: {
      productShot: true,
      masterMode: true,
      premiumTemplates: true
    }
  }
};

// Stripe 价格 ID（需要在 Stripe Dashboard 创建）
export const STRIPE_PRICES = {
  pro_monthly: 'price_pro_monthly',     // 替换为实际 Price ID
  pro_yearly: 'price_pro_yearly',
  ultra_monthly: 'price_ultra_monthly',
  ultra_yearly: 'price_ultra_yearly'
};

// Queue 消息类型
export interface QueueMessage {
  taskId: string;
  type: 'generate' | 'batch' | 'product_shot';
  timestamp: number;
}

// 用户类型
export interface User {
  id: number;
  username: string;
  role: 'user' | 'admin';
  tier: UserTier;
  dailyGenerationCount: number;
  lastGenerationDate: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

// Session 类型
export interface Session {
  username: string;
  userId: number | null;
  role: 'user' | 'admin';
  tier: UserTier;
  expiresAt: number;
}

// 用户配额信息
export interface UserQuota {
  tier: UserTier;
  dailyUsed: number;
  dailyLimit: number;
  remaining: number;
  features: TierConfig['features'];
}

// 模板类型
export interface Template {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  prompt: string;
  malePrompt: string | null;
  femalePrompt: string | null;
  defaultGender: 'male' | 'female';
  defaultFraming: string;
  tags: string[];
  variables: Variable[];
}

export interface Variable {
  name: string;
  label: string;
  type: 'select' | 'text';
  options?: string[];
  defaultValue?: string;
}

// 标签类型
export interface Tag {
  id: string;
  name: string;
  color: string;
}

// 生成图片类型
export interface GeneratedImage {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  type: string;
  config: Record<string, unknown> | null;
  prompt: string | null;
  userId: number | null;
  isPublic: boolean;
  timestamp: number;
  username?: string;
}

// 任务类型
export interface Task {
  id: string;
  userId: number;
  type: 'generate' | 'batch' | 'product_shot';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  inputData: Record<string, unknown>;
  outputData: Record<string, unknown> | null;
  errorMessage: string | null;
  batchId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// 批次进度类型
export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  processing: number;
  pending: number;
}

// 资源类型
export interface Asset {
  id: string;
  name: string;
  url: string;
  thumbnailUrl: string | null;
  type: string;
  timestamp: number;
}

// API 响应类型
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// 模型配置类型
export interface ModelConfig {
  framing: string;
  scene: string;
  visualPurpose: string;
  camera: string;
  lens: string;
  lighting: string;
  mood: string;
  skinTexture: string;
  aspectRatio: string;
  modelVibe: string;
}
