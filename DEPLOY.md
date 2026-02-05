# Cloudflare 部署指南

本项目使用 Cloudflare Workers (后端 API) + Pages (前端) 架构。

## 架构说明

```
┌─────────────────────────────────────────────────────┐
│                    Cloudflare                        │
│  ┌─────────────┐              ┌─────────────────┐   │
│  │   Pages     │   API 请求   │    Workers      │   │
│  │  (前端静态) │ ──────────── │   (后端 API)    │   │
│  └─────────────┘              └─────────────────┘   │
│         │                            │              │
│         │                     ┌──────┴──────┐       │
│         │                     │             │       │
│         │                ┌────┴───┐   ┌────┴────┐   │
│         │                │   D1   │   │   R2    │   │
│         │                │ 数据库 │   │  存储   │   │
│         │                └────────┘   └─────────┘   │
│         │                                           │
│         └───── 调用 Gemini API ─────────────────────│
└─────────────────────────────────────────────────────┘
```

## 前置条件

1. 安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
   ```bash
   npm install -g wrangler
   ```

2. 登录 Cloudflare
   ```bash
   wrangler login
   ```

## 部署步骤

### 1. 创建 D1 数据库

```bash
cd workers

# 创建生产数据库
wrangler d1 create lyra-db

# 记录返回的 database_id，更新到 wrangler.toml
```

### 2. 创建 R2 存储桶

```bash
# 创建存储桶
wrangler r2 bucket create lyra-storage
```

### 3. 更新 wrangler.toml

编辑 `workers/wrangler.toml`，填入正确的 database_id：

```toml
[[d1_databases]]
binding = "DB"
database_name = "lyra-db"
database_id = "YOUR_D1_DATABASE_ID"  # 替换为实际 ID
```

### 4. 初始化数据库

```bash
# 运行数据库迁移
wrangler d1 execute lyra-db --file=./migrations/001_init.sql
```

### 5. 设置环境变量（Secrets）

```bash
# 设置管理员密码
wrangler secret put ADMIN_PASSWORD
# 输入你的管理员密码

# 设置 Gemini API Key
wrangler secret put GEMINI_API_KEY
# 输入你的 Gemini API Key
```

### 6. 部署 Workers

```bash
cd workers
npm install
wrangler deploy
```

部署成功后会显示 Workers URL，例如：`https://lyra-api.your-subdomain.workers.dev`

### 7. 配置 R2 公开访问

在 Cloudflare Dashboard 中：
1. 进入 R2 > lyra-storage
2. 设置 > 公开访问 > 绑定自定义域名或使用 r2.dev 子域名

### 8. 部署前端 (Pages)

#### 方法 A: 使用 GitHub 集成（推荐）

1. 将代码推送到 GitHub
2. 在 Cloudflare Dashboard > Pages > 创建项目
3. 连接 GitHub 仓库
4. 设置构建配置：
   - 构建命令: `npm run build`
   - 构建输出目录: `dist`
   - 根目录: `/` (项目根目录)

5. 添加环境变量：
   - `VITE_API_URL`: Workers 的 URL (例如 `https://lyra-api.your-subdomain.workers.dev`)

#### 方法 B: 手动部署

```bash
# 在项目根目录
npm run build

# 部署到 Pages
wrangler pages deploy dist --project-name=lyra
```

### 9. 配置自定义域名

#### Workers 域名
1. Cloudflare Dashboard > Workers & Pages > lyra-api
2. 设置 > 触发器 > 添加自定义域名
3. 添加 `api.yourdomain.com`

#### Pages 域名
1. Cloudflare Dashboard > Workers & Pages > lyra (Pages)
2. 自定义域 > 添加自定义域名
3. 添加 `yourdomain.com`

## 前端 API 配置

在部署前端之前，需要配置 API 地址。创建 `.env.production` 文件：

```env
VITE_API_URL=https://api.yourdomain.com
```

或者在 Pages 设置中添加环境变量。

前端代码中使用：
```typescript
const API_BASE = import.meta.env.VITE_API_URL || '';
fetch(`${API_BASE}/api/auth/login`, ...)
```

## 本地开发

### 后端开发

```bash
cd workers
npm install
npm run dev
# Workers 将在 http://localhost:8787 运行
```

### 前端开发

```bash
# 在项目根目录
npm install
npm run dev
# 前端将在 http://localhost:3000 运行
# API 请求会代理到 http://localhost:8787
```

## 数据迁移

如果需要从旧的 SQLite 数据库迁移数据到 D1：

1. 导出旧数据为 SQL
2. 使用 `wrangler d1 execute` 导入

```bash
# 导出旧数据（在旧服务器上）
sqlite3 lyra.db .dump > backup.sql

# 导入到 D1
wrangler d1 execute lyra-db --file=./backup.sql
```

## 常见问题

### 1. Gemini API 在中国无法访问

Cloudflare Workers 部署在全球边缘节点，API 请求从 Workers 发出，不受国内网络限制。

### 2. R2 图片无法访问

确保 R2 存储桶已配置公开访问，或者通过 Workers 代理访问。

### 3. 数据库连接错误

检查 wrangler.toml 中的 database_id 是否正确，以及数据库是否已初始化。

## 环境变量清单

| 变量名 | 说明 | 设置方式 |
|--------|------|----------|
| ADMIN_USERNAME | 管理员用户名 | wrangler.toml [vars] |
| ADMIN_PASSWORD | 管理员密码 | wrangler secret |
| GEMINI_API_KEY | Gemini API 密钥 | wrangler secret |

## 监控和日志

```bash
# 查看实时日志
wrangler tail

# 查看 Workers 分析
# Cloudflare Dashboard > Workers & Pages > lyra-api > 分析
```
