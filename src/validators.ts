/**
 * Zod Validation Schemas
 * 
 * Centralized input validation for all API endpoints.
 * Used with @hono/zod-validator middleware.
 */

import { z } from 'zod';

// ========== Auth Schemas ==========

export const registerSchema = z.object({
    username: z.string()
        .min(3, '用户名长度需在3-20字符之间')
        .max(20, '用户名长度需在3-20字符之间')
        .regex(/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/, '用户名只能包含字母、数字、下划线和中文'),
    password: z.string().min(6, '密码长度至少6位'),
});

export const loginSchema = z.object({
    username: z.string().min(1, '请提供用户名'),
    password: z.string().min(1, '请提供密码'),
});

export const changePasswordSchema = z.object({
    oldPassword: z.string().min(1, '请输入当前密码'),
    newPassword: z.string().min(6, '新密码长度至少6位'),
});

// ========== Template Schemas ==========

export const createTemplateSchema = z.object({
    name: z.string().min(1, '模板名称不能为空'),
    description: z.string().optional(),
    imageUrl: z.string().optional(),
    prompt: z.string().optional(),
    malePrompt: z.string().optional().nullable(),
    femalePrompt: z.string().optional().nullable(),
    defaultGender: z.enum(['male', 'female']).optional(),
    defaultFraming: z.string().optional(),
    tags: z.array(z.string()).optional(),
    variables: z.array(z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(['text', 'select', 'color']),
        options: z.array(z.string()).optional(),
        default: z.string().optional(),
    })).optional(),
});

export const updateTemplateSchema = createTemplateSchema.partial();

// ========== Tag Schemas ==========

export const createTagSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1, '标签名称不能为空'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式错误').optional(),
});

export const updateTagSchema = z.object({
    name: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

// ========== Generate Schemas ==========

export const generateTemplateSchema = z.object({
    templateId: z.string().min(1, '请选择模板'),
    variables: z.record(z.string(), z.string()).optional(),
    gender: z.enum(['male', 'female']).optional(),
    framing: z.string().optional(),
    userPhoto: z.string().optional(), // base64
    parentImageId: z.string().optional(), // for iteration
});

export const generateIterateSchema = z.object({
    imageId: z.string().min(1),
    feedback: z.string().min(1, '请输入修改意见'),
});

export const productShotSchema = z.object({
    productImage: z.string().min(1, '请上传产品图'),
    backgroundPrompt: z.string().optional(),
    aspectRatio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).optional(),
});

// ========== Image Schemas ==========

export const setPublicSchema = z.object({
    isPublic: z.boolean(),
});

export const uploadThumbnailSchema = z.object({
    imageId: z.string().min(1),
    thumbnailData: z.string().min(1), // base64
});

// ========== Feedback Schemas ==========

export const submitFeedbackSchema = z.object({
    imageId: z.string().min(1),
    rating: z.number().int().refine(val => val === 1 || val === -1, {
        message: '评分必须为 1 或 -1',
    }),
});

// ========== Task Schemas ==========

export const cancelTaskSchema = z.object({
    taskId: z.string().min(1),
});

// ========== Batch Schemas ==========

export const batchGenerateSchema = z.object({
    templateId: z.string().min(1),
    count: z.number().int().min(1).max(10),
    variables: z.record(z.string(), z.string()).optional(),
    gender: z.enum(['male', 'female']).optional(),
    framing: z.string().optional(),
});

// ========== Asset Schemas ==========

export const createAssetSchema = z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    type: z.enum(['image', 'video', 'audio']).optional(),
});

// ========== Pagination Schemas ==========

export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
});

// ========== Custom Zod Error Formatter ==========

/**
 * Get the first error message from a Zod error
 */
export function getFirstError(error: z.ZodError): string {
    return error.issues[0]?.message || '输入验证失败';
}
