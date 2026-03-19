# AI Chat 本地开发指南

## 两种 API 模式

### 1. Edge Function 模式（默认）
- **文件**: `api/chat.js`
- **运行环境**: Vercel Edge Runtime
- **日志存储**: Vercel Blob（生产）/ Console（本地）
- **适用场景**: 生产环境、Vercel 部署

### 2. Node.js API 模式（本地开发）
- **文件**: `api/chat-local.js`
- **运行环境**: Node.js
- **日志存储**: 本地文件系统 (`./logs/`)
- **适用场景**: 本地开发、需要结构化日志文件

---

## 本地开发步骤

### 方式一：使用 Edge Function（推荐简单测试）

```bash
# 设置环境变量
export KIMI_API_KEY="your-kimi-api-key"

# 启动本地服务器
vercel dev
```

对话日志将输出到控制台，格式如下：

```
============================================================
📝 CHAT LOG (Local Development Mode)
============================================================
Path: chat-conversations/xxx/2026-03-19/uuid.json
Time: 2026-03-19T10:30:00.000Z
Article: 斯坦福AI小镇论文阅读
Success: true
------------------------------------------------------------
User: 这篇文章的核心观点是什么？
------------------------------------------------------------
Assistant: 这篇文章的核心观点是...
============================================================
```

### 方式二：使用 Node.js API（需要本地日志文件）

```bash
# 1. 设置环境变量
export KIMI_API_KEY="your-kimi-api-key"

# 2. 安装依赖（确保有 express 或类似的 Node 服务器）
npm install

# 3. 启动 Next.js/Vercel 本地开发（会自动使用 Node.js API）
vercel dev
```

或者使用 Node 直接运行：

```bash
# 需要配合前端代理配置
node api/chat-local.js
```

日志文件将保存到：
```
./logs/chat-conversations/{articleSlug}/{date}/{conversationId}.json
```

---

## 环境变量

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `KIMI_API_KEY` | ✅ | Moonshot (Kimi) API Key |
| `BLOB_READ_WRITE_TOKEN` | ❌ | Vercel Blob Token（仅生产环境需要） |

---

## 日志结构

每个对话保存为 JSON 文件：

```json
{
  "conversationId": "uuid",
  "articleTitle": "文章标题",
  "articleUrl": "/tech/xxx/",
  "userMessage": "用户问题",
  "assistantResponse": "AI回答",
  "latency": 1234,
  "timestamp": "2026-03-19T10:30:00.000Z",
  "model": "kimi-k2.5",
  "tokenUsage": {
    "prompt_tokens": 100,
    "completion_tokens": 200
  },
  "success": true
}
```

---

## 注意事项

1. **日志文件不会提交到 Git**（已在 `.gitignore` 中排除）
2. **本地开发时**，Edge Function 不会写入文件，只输出到 Console
3. **生产环境**，必须设置 `BLOB_READ_WRITE_TOKEN` 才能保存日志
