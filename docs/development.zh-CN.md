# 开发

## 前置条件

- Node.js 24+（CI 工作流要求）
- npm

## 安装

```bash
npm ci
cp .env.example .env
# 编辑 .env 填入你的密钥
# 将 serviceAccountKey.json 放到 src/services/
```

## 脚本

```bash
npm run typecheck   # tsc --noEmit（类型检查）
npm run build       # tsc（编译 src/ → dist/）
npm run lint        # eslint .
npm run format      # prettier --write .
node dist/app.js    # 运行编译后的 bot
```

Pre-commit 钩子（Husky + lint-staged）自动格式化和检查暂存的 `.ts` 文件。

## CI

GitHub Actions（`.github/workflows/ci.yml`）在 push/PR 到 `main`/`master` 时运行：

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run format:check`

没有配置测试套件（`test` 脚本是占位符）。

## 关键设计决策

### 为什么用 Gemini 做图片识别而不是 DeepSeek？

DeepSeek v4 不支持 `image_url` 内容部分（返回 400 `unknown variant 'image_url'`）。图片描述由 Gemini 2.5 Flash 通过 Cloudflare AI Gateway 生成，然后以纯文本形式注入 DeepSeek 的提示词中。

### 为什么用 `sendMessage` + `editMessageText` 而不是 `sendMessageDraft`？

Telegram 的 `sendMessageDraft` API 对群组中的 bot 返回 `TEXTDRAFT_PEER_INVALID`。Bot 使用占位符消息（`"…"`) 后续每 800ms 编辑的方式流式回复。

### 为什么用 `stopWhen: stepCountIs(5)`？

AI SDK v6 默认 `stepCountIs(1)`，即第一步后停止执行。当 LLM 调用 `webSearch` 时，需要第二步基于搜索结果生成最终回复。`stepCountIs(5)` 允许最多 5 步（初始调用 + 最多 4 轮工具调用）。

### 为什么分类用 `generateText` 而不是 `generateObject`？

DeepSeek 的 Chat Completions API 不支持 `json_schema` response_format（返回 400 `This response_format type is unavailable now`）。分类提示词指示模型以原始 JSON 格式回复，然后用 Zod 解析。

### 为什么用 `.chat()` 而不是默认的模型工厂方法？

`@ai-sdk/openai` v3 默认使用 Responses API（`/responses` 端点）。DeepSeek 只支持 Chat Completions API（`/chat/completions`）。使用 `provider.chat("model-id")` 显式选择 Chat Completions API。

### 进程内状态

对话缓冲区、用户缓存、更新去重集合、主动插话定时器状态全部在进程内存中。重启会丢失所有对话上下文，主动插话检查器也会停止。对于单群组个人 bot 来说这是可接受的。

## Firestore Schema

### `users/{uid}`

```typescript
interface User {
  uid: string;
  nickname: string;
  memories: string[]; // 最多 30 条，最新的在最后
  nightyTimestamp?: number; // 毫秒时间戳
  lastMorningGreet?: number; // 毫秒时间戳
}
```

### `images/{fileId}`

```typescript
interface CachedImage {
  fileId: string; // Telegram file_id
  description: string; // Gemini 生成的中文描述
  cachedAt: number; // 毫秒时间戳，30 天 TTL
}
```
