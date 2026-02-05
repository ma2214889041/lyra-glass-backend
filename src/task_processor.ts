import { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { taskDb, imageDb, promptHistoryDb } from './db';
import { generateEyewearImage, generateFromTemplate, generateProductShot } from './gemini';
import { saveImage } from './storage';
import { Env, ModelConfig } from './types';

// 并发控制：限制同时执行的任务数
async function processWithConcurrencyLimit<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number
): Promise<T[]> {
    const results: T[] = [];
    const executing: Set<Promise<void>> = new Set();

    for (const task of tasks) {
        const p = Promise.resolve().then(async () => {
            const result = await task();
            results.push(result);
        });

        executing.add(p);
        p.finally(() => executing.delete(p));

        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }

    await Promise.all(executing);
    return results;
}

export async function processTask(env: Env, taskId: string): Promise<boolean> {
    const task = await taskDb.getById(env.DB, taskId);
    if (!task) return false;

    if (task.status !== 'pending' && task.status !== 'processing') {
        return false;
    }

    // Ensure status is processing
    if (task.status === 'pending') {
        await taskDb.startProcessing(env.DB, taskId);
    }

    try {
        const input = task.inputData;
        const userId = task.userId;
        const imageBase64 = input.imageBase64 as string;

        let resultImageBase64: string;
        let imageType = 'generate';
        let saveConfig: any = {};
        let savePrompt: string | null = null;

        // Batch Task Processing
        if (task.type === 'batch') {
            const combinations = input.combinations as any[];
            const basePrompt = input.basePrompt as string;
            const templateId = input.templateId as string | undefined;
            const templateName = input.templateName as string | undefined;
            const aspectRatio = input.aspectRatio as string || '3:4';
            const concurrency = Math.min(5, Math.max(1, (input.concurrency as number) || 3));
            const batchId = crypto.randomUUID();

            let createdCount = 0;

            for (const combo of combinations) {
                let prompt = basePrompt;
                const variableValues: Record<string, string> = {};
                for (const [key, value] of Object.entries(combo)) {
                    if (typeof value === 'string') {
                        variableValues[key] = value;
                        prompt = prompt.replace(new RegExp(`{${key}}`, 'g'), value);
                    }
                }

                const subTaskId = crypto.randomUUID();
                await taskDb.create(env.DB, subTaskId, userId, 'generate', {
                    imageBase64,
                    prompt,
                    aspectRatio,
                    templateId,
                    templateName,
                    variableValues,
                }, batchId);
                createdCount++;
            }

            await taskDb.complete(env.DB, taskId, {
                success: true,
                batchId,
                subTaskCount: createdCount,
                message: `Successfully created ${createdCount} generation tasks`
            });

            // 触发批次任务的并发处理，使用用户设置的并行数
            await processBatchTasks(env, batchId, concurrency);
            return true;
        }

        // Product Shot Task Processing (单角度 - 改造后)
        if (task.type === 'product_shot') {
            const angle = input.angle as string;
            const config = input.config as {
                backgroundColor: string;
                reflectionEnabled: boolean;
                shadowStyle: string;
                outputSize: string;
                aspectRatio: string;
            };

            console.log(`[ProductShot] Generating angle: ${angle}`);

            // 生成单个角度的产品图
            const resultImageBase64 = await generateProductShot(
                env.GEMINI_API_KEY,
                imageBase64,
                angle,
                {
                    backgroundColor: config.backgroundColor,
                    reflectionEnabled: config.reflectionEnabled,
                    shadowStyle: config.shadowStyle,
                    aspectRatio: config.aspectRatio
                }
            );

            // 保存图片
            const imageId = crypto.randomUUID();
            const { url, thumbnailUrl } = await saveImage(
                env.R2,
                resultImageBase64,
                userId,
                imageId
            );

            // 保存到数据库
            await imageDb.save(env.DB, {
                id: imageId,
                url,
                thumbnailUrl,
                type: 'product_shot',
                config: { angle, ...config },
                prompt: null
            }, userId);

            // 完成任务
            await taskDb.complete(env.DB, taskId, {
                success: true,
                angle,
                imageUrl: url,
                thumbnailUrl,
                imageId
            });

            console.log(`[ProductShot] Completed angle: ${angle}`);
            return true;
        }

        // Single Image Generation (generate)
        // 1. Model Config based generation (Eyewear)
        if (input.modelConfig) {
            const modelConfig = input.modelConfig as ModelConfig;
            const size = (input.imageQuality as string) || '1K';
            const gender = (input.gender as string) || 'female';

            resultImageBase64 = await generateEyewearImage(
                env.GEMINI_API_KEY,
                imageBase64,
                size,
                modelConfig,
                gender
            );

            imageType = 'eyewear';
            saveConfig = modelConfig;
        }
        // 2. Prompt based generation (Template or Custom)
        else if (input.prompt) {
            const prompt = input.prompt as string;
            const aspectRatio = (input.aspectRatio as string) || '3:4';

            resultImageBase64 = await generateFromTemplate(
                env.GEMINI_API_KEY,
                imageBase64,
                prompt,
                aspectRatio
            );

            imageType = 'template';
            saveConfig = {
                templateId: input.templateId,
                templateName: input.templateName,
                variableValues: input.variableValues,
                customPrompt: !input.templateId
            };
            savePrompt = prompt;

            // Save prompt history if not custom
            if (input.templateId && input.templateId !== 'custom') {
                await promptHistoryDb.save(
                    env.DB,
                    userId,
                    prompt,
                    input.templateId as string,
                    (input.variableValues as Record<string, unknown>) || {},
                    true
                );
            }
        } else {
            throw new Error('Invalid task input: missing prompt or modelConfig');
        }

        // Save Logic (Common)
        const imageId = crypto.randomUUID();
        const { url, thumbnailUrl } = await saveImage(
            env.R2,
            resultImageBase64,
            userId,
            imageId
        );

        // Save to Image DB
        await imageDb.save(env.DB, {
            id: imageId,
            url,
            thumbnailUrl,
            type: imageType,
            config: saveConfig,
            prompt: savePrompt
        }, userId);

        // Complete Task
        await taskDb.complete(env.DB, taskId, {
            success: true,
            imageUrl: url,
            thumbnailUrl,
            imageId
        });

        return true;

    } catch (error: any) {
        console.error(`Task ${taskId} failed:`, error);
        await taskDb.fail(env.DB, taskId, error.message || 'Processing failed');
        return false;
    }
}

// 处理批次任务（按 batchId 并发）
export async function processBatchTasks(
    env: Env,
    batchId: string,
    concurrency: number = 3
): Promise<void> {
    const tasks = await taskDb.getByBatchId(env.DB, batchId);
    const pendingTasks = tasks.filter(t => t.status === 'pending');

    if (pendingTasks.length === 0) return;

    console.log(`[Batch] Processing ${pendingTasks.length} tasks with concurrency ${concurrency}`);

    // 创建任务处理函数数组，每个任务之间添加随机延迟避免同时请求
    const taskFunctions = pendingTasks.map((task, index) => async () => {
        // 添加随机延迟避免同时请求（0-800ms）
        if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 800));
        }
        return processTask(env, task.id);
    });

    // 受控并发执行
    await processWithConcurrencyLimit(taskFunctions, concurrency);
}

// 通用的并发任务处理（所有类型任务）
export async function processPendingTasks(env: Env, limit: number = 5, concurrency: number = 3): Promise<number> {
    const tasks = await taskDb.getPending(env.DB, limit);

    if (tasks.length === 0) return 0;

    console.log(`[Queue] Processing ${tasks.length} pending tasks with concurrency ${concurrency}`);

    // 创建任务处理函数数组
    const taskFunctions = tasks.map((task, index) => async () => {
        // 添加随机延迟避免同时请求（0-500ms）
        if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 500));
        }
        return processTask(env, task.id);
    });

    // 受控并发执行
    const results = await processWithConcurrencyLimit(taskFunctions, concurrency);

    return results.filter(Boolean).length;
}
