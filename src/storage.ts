import type { R2Bucket, R2ListOptions, R2Object, D1Database } from '@cloudflare/workers-types';

/**
 * 保存图片到 R2
 * @param r2 R2 Bucket 绑定
 * @param imageData base64 图片数据或 data URL
 * @param userId 用户 ID
 * @param imageId 图片唯一 ID
 * @returns 图片访问 URL
 */
export async function saveImage(
  r2: R2Bucket,
  imageData: string,
  userId: number | string,
  imageId: string
): Promise<{ url: string; thumbnailUrl: string | null }> {
  // 从 data URL 中提取 base64 数据
  let base64Data = imageData;
  if (imageData.startsWith('data:')) {
    base64Data = imageData.split(',')[1];
  }

  // 将 base64 转换为 Uint8Array
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // 上传到 R2
  const key = `generated/${userId}/${imageId}.png`;
  await r2.put(key, bytes, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable'
    }
  });

  // 返回访问 URL (通过 R2 公开访问或自定义域名)
  // 注意：需要在 Cloudflare Dashboard 中配置 R2 公开访问
  const url = `/r2/${key}`;

  console.log(`[Storage] Image saved: ${url}`);

  // Workers 不支持 sharp，暂不生成缩略图
  // 可以使用 Cloudflare Image Resizing 来按需生成缩略图
  return { url, thumbnailUrl: null };
}

/**
 * 从 R2 删除图片
 * @param r2 R2 Bucket 绑定
 * @param imageUrl 图片 URL
 */
export async function deleteImage(r2: R2Bucket, imageUrl: string): Promise<boolean> {
  if (!imageUrl) return false;

  // 从 URL 中提取 key
  // URL 格式: /r2/generated/{userId}/{imageId}.png
  let key = imageUrl;
  if (imageUrl.startsWith('/r2/')) {
    key = imageUrl.slice(4); // 去掉 /r2/ 前缀
  } else if (imageUrl.startsWith('http')) {
    // 外部 URL，尝试提取 key
    const match = imageUrl.match(/generated\/\d+\/[\w-]+\.png/);
    if (match) {
      key = match[0];
    } else {
      console.warn(`[Storage] Cannot extract key from URL: ${imageUrl}`);
      return false;
    }
  }

  try {
    await r2.delete(key);
    console.log(`[Storage] Deleted: ${key}`);
    return true;
  } catch (error) {
    console.error(`[Storage] Delete failed: ${key}`, error);
    return false;
  }
}

/**
 * 保存资源到 R2 (模板图片等)
 * @param r2 R2 Bucket 绑定
 * @param imageData base64 图片数据
 * @param name 资源名称
 */
export async function saveAsset(
  r2: R2Bucket,
  imageData: string,
  name: string
): Promise<{ id: string; url: string; thumbnailUrl: string | null }> {
  // 从 data URL 中提取 base64 数据
  let base64Data = imageData;
  if (imageData.startsWith('data:')) {
    base64Data = imageData.split(',')[1];
  }

  // 将 base64 转换为 Uint8Array
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // 生成唯一 ID
  const timestamp = Date.now();
  const id = timestamp.toString();

  // 安全的文件名
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${timestamp}_${safeName}.png`;
  const key = `assets/${filename}`;

  // 上传到 R2
  await r2.put(key, bytes, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000'
    }
  });

  const url = `/r2/${key}`;
  console.log(`[Storage] Asset saved: ${url}`);

  return { id, url, thumbnailUrl: null };
}

/**
 * 保存缩略图到 R2
 */
export async function saveThumbnail(
  r2: R2Bucket,
  thumbnailData: string,
  userId: number | string,
  imageId: string
): Promise<string> {
  let base64Data = thumbnailData;
  let contentType = 'image/jpeg';

  if (thumbnailData.startsWith('data:')) {
    if (thumbnailData.startsWith('data:image/png')) {
      contentType = 'image/png';
    }
    base64Data = thumbnailData.split(',')[1];
  }

  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
  const key = `generated/${userId}/${imageId}_thumb.${ext}`;

  await r2.put(key, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable'
    }
  });

  const url = `/r2/${key}`;
  console.log(`[Storage] Thumbnail saved: ${url} (${(bytes.length / 1024).toFixed(1)}KB)`);
  return url;
}

/**
 * 从 R2 删除资源
 */
export async function deleteAsset(r2: R2Bucket, assetUrl: string): Promise<boolean> {
  return deleteImage(r2, assetUrl);
}

/**
 * 从 R2 获取图片
 * @param r2 R2 Bucket 绑定
 * @param key 图片 key
 */
export async function getImage(r2: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return await r2.get(key);
}

/**
 * 清理过期图片
 * @param r2 R2 Bucket 绑定
 * @param db D1 数据库
 * @param daysToKeep 保留天数
 */
export async function cleanupOldImages(
  r2: R2Bucket,
  db: D1Database,
  daysToKeep: number = 30
): Promise<number> {
  const cutoffTime = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);

  console.log(`[Cleanup] Starting cleanup of images older than ${daysToKeep} days...`);

  try {
    // 获取过期图片列表
    const { results: oldImages } = await db.prepare(`
      SELECT id, url, thumbnail_url FROM generated_images WHERE created_at < ?
    `).bind(cutoffTime).all();

    let deletedCount = 0;

    // 删除 R2 文件（原图 + 缩略图）
    for (const img of oldImages) {
      if (await deleteImage(r2, img.url as string)) {
        deletedCount++;
      }
      if (img.thumbnail_url) {
        await deleteImage(r2, img.thumbnail_url as string);
      }
    }

    // 删除数据库记录
    if (deletedCount > 0) {
      await db.prepare('DELETE FROM generated_images WHERE created_at < ?').bind(cutoffTime).run();
      console.log(`[Cleanup] Deleted ${deletedCount} expired images`);
    } else {
      console.log('[Cleanup] No expired images to clean up');
    }

    return deletedCount;
    // ... (cleanupOldImages implementation)
    return deletedCount;
  } catch (error) {
    console.error('[Cleanup] Failed:', error);
    return 0;
  }
}

/**
 * 清理孤儿资源 (assets/ 下的文件，但不在 templates 表中)
 * @param r2 R2 Bucket 绑定
 * @param db D1 数据库
 */
export async function cleanupOrphanedAssets(
  r2: R2Bucket,
  db: D1Database
): Promise<{ deleted: number; scanned: number; errors: number }> {
  console.log('[Cleanup] Starting orphaned assets cleanup...');

  try {
    // 1. 获取所有模板图片 URL
    const { results } = await db.prepare('SELECT imageUrl FROM templates WHERE imageUrl IS NOT NULL').all();
    const activeUrls = new Set(results.map((r: any) => r.imageUrl));
    console.log(`[Cleanup] Found ${activeUrls.size} active template images.`);

    // 2. 列出 R2 assets/ 下的所有文件
    // 注意：如果 assets 数量非常大，可能需要分批处理或限制单次运行时间
    let listOptions: R2ListOptions = { prefix: 'assets/' };
    let listed = await r2.list(listOptions);

    let scanned = 0;
    let deleted = 0;
    let errors = 0;

    const processObjects = async (objects: R2Object[]) => {
      for (const obj of objects) {
        scanned++;
        const key = obj.key;
        // 构造对应的 URL (假设所有 template imageUrl 都是 /r2/xxx 格式)
        const url = `/r2/${key}`;

        // 检查是否在使用的 URL 集合中
        // 注意：这里需要精确匹配。如果 DB 中存的是完整 URL (http...)，这里需要相应调整
        if (!activeUrls.has(url)) {
          console.log(`[Cleanup] Deleting orphan: ${key}`);
          try {
            await r2.delete(key);
            deleted++;
          } catch (e) {
            console.error(`[Cleanup] Failed to delete ${key}`, e);
            errors++;
          }
        }
      }
    };

    await processObjects(listed.objects);

    while (listed.truncated) {
      listOptions.cursor = listed.cursor;
      listed = await r2.list(listOptions);
      await processObjects(listed.objects);
    }

    console.log(`[Cleanup] Finished. Scanned: ${scanned}, Deleted: ${deleted}, Errors: ${errors}`);
    return { deleted, scanned, errors };
  } catch (error) {
    console.error('[Cleanup] Orphan cleanup failed:', error);
    throw error;
  }
}
