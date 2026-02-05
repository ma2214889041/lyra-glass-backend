// Cloudflare Workers 环境绑定类型
export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  GEMINI_API_KEY: string;
}

// 用户类型
export interface User {
  id: number;
  username: string;
  role: 'user' | 'admin';
}

// Session 类型
export interface Session {
  username: string;
  userId: number | null;
  role: 'user' | 'admin';
  expiresAt: number;
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
