/**
 * Drizzle ORM Schema for D1 Database
 * 
 * This file defines the database schema using Drizzle ORM.
 * It maps to the existing D1 database structure.
 */

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ========== Tags ==========
export const tags = sqliteTable('tags', {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    color: text('color').default('#6366f1'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ========== Templates ==========
export const templates = sqliteTable('templates', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url').notNull(),
    prompt: text('prompt').default(''),
    malePrompt: text('male_prompt'),
    femalePrompt: text('female_prompt'),
    defaultGender: text('default_gender').default('female'),
    defaultFraming: text('default_framing').default('Close-up'),
    tags: text('tags').default('[]'), // JSON string
    variables: text('variables').default('[]'), // JSON string
    hasText: integer('has_text').default(0),
    hasTitle: integer('has_title').default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ========== Users ==========
export const users = sqliteTable('users', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').default('user'),
    tier: text('tier').default('free'),
    dailyGenerationCount: integer('daily_generation_count').default(0),
    lastGenerationDate: text('last_generation_date'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    subscriptionStatus: text('subscription_status'),
    subscriptionEndsAt: integer('subscription_ends_at'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ========== Assets ==========
export const assets = sqliteTable('assets', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    type: text('type').default('image'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// ========== Generated Images ==========
export const generatedImages = sqliteTable('generated_images', {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    type: text('type').notNull(),
    config: text('config'), // JSON string
    userId: integer('user_id').references(() => users.id),
    prompt: text('prompt'),
    isPublic: integer('is_public').default(0),
    parentImageId: text('parent_image_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (table) => ({
    userCreatedIdx: index('idx_images_user_created').on(table.userId, table.createdAt),
    publicIdx: index('idx_images_public').on(table.isPublic, table.createdAt),
}));

// ========== Sessions ==========
export const sessions = sqliteTable('sessions', {
    token: text('token').primaryKey(),
    username: text('username').notNull(),
    userId: integer('user_id').references(() => users.id),
    role: text('role').default('user'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    expiresAt: integer('expires_at').notNull(),
}, (table) => ({
    expiresIdx: index('idx_sessions_expires').on(table.expiresAt),
}));

// ========== Favorites ==========
export const favorites = sqliteTable('favorites', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id),
    templateId: text('template_id').notNull().references(() => templates.id),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (table) => ({
    userIdx: index('idx_favorites_user').on(table.userId, table.createdAt),
    uniqueUserTemplate: uniqueIndex('favorites_user_template_unique').on(table.userId, table.templateId),
}));

// ========== Prompt History ==========
export const promptHistory = sqliteTable('prompt_history', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id),
    templateId: text('template_id'),
    prompt: text('prompt').notNull(),
    variables: text('variables').default('{}'), // JSON string
    isSuccessful: integer('is_successful').default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (table) => ({
    userIdx: index('idx_prompt_history_user').on(table.userId, table.createdAt),
}));

// ========== Feedback ==========
export const feedback = sqliteTable('feedback', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id),
    imageId: text('image_id').notNull().references(() => generatedImages.id),
    rating: integer('rating').notNull(), // -1 or 1
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (table) => ({
    uniqueUserImage: uniqueIndex('feedback_user_image_unique').on(table.userId, table.imageId),
}));

// ========== Tasks ==========
export const tasks = sqliteTable('tasks', {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    type: text('type').notNull(), // 'generate' | 'batch' | 'product_shot'
    status: text('status').default('pending'), // 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
    inputData: text('input_data').notNull(), // JSON string
    outputData: text('output_data'), // JSON string
    errorMessage: text('error_message'),
    progress: integer('progress').default(0),
    batchId: text('batch_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
}, (table) => ({
    userStatusIdx: index('idx_tasks_user_status').on(table.userId, table.status),
    statusIdx: index('idx_tasks_status').on(table.status),
}));

// ========== Type Exports ==========
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;

export type GeneratedImage = typeof generatedImages.$inferSelect;
export type NewGeneratedImage = typeof generatedImages.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Favorite = typeof favorites.$inferSelect;
export type NewFavorite = typeof favorites.$inferInsert;

export type PromptHistory = typeof promptHistory.$inferSelect;
export type NewPromptHistory = typeof promptHistory.$inferInsert;

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
