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

### 为什么用工具调用架构而不是流式回复？

之前的流式架构（`streamText` + `sendMessage` + `editMessageText`）直接输出文本。工具调用架构（`generateText` + `send_message`/`dismiss` 工具）让沉默成为第一类结构化选择——模型必须显式调用 `send_message` 才能说话。这重塑了概率分布，减少了不必要的 AI 啰嗦。内心独白（没有工具调用的原始文本输出）被视为"dismiss"并附带可选的 `rawText` 兜底。

其他好处：

- **贴纸分发**：`sendSticker` 工具让模型通过中文描述选择贴纸。`adoptSticker` 工具让模型将群友发送的贴纸收入自己的贴纸库。
- **记忆工具**：`saveMemory`、`setNickname`、`deleteMemory` 是带 uid 验证的一等操作。
- **沉默重试**：当被触发但被 dismiss 时，handler 可以用递增的提示重试。

### 为什么分类用 `generateText` 而不是 `generateObject`？

DeepSeek 的 Chat Completions API 不支持 `json_schema` response_format（返回 400 `This response_format type is unavailable now`）。分类提示词指示模型以原始 JSON 格式回复，然后用 Zod 解析。

### 为什么用 `.chat()` 而不是默认的模型工厂方法？

`@ai-sdk/openai` v3 默认使用 Responses API（`/responses` 端点）。DeepSeek 只支持 Chat Completions API（`/chat/completions`）。使用 `provider.chat("model-id")` 显式选择 Chat Completions API。

### 为什么用两阶段主动探测？

每次主动检查都运行完整模型很昂贵。探测门使用 `flashNoThinkModel`（最便宜最快）配合简化提示词和只有 `dismiss`/`send_message` 工具。如果探测决定话题相关，完整模型才运行所有工具。这平均节省约 80% 的主动计算。

### 为什么用 `formatForTelegramHtml`？

DeepSeek 输出 Markdown（粗体、斜体、代码、链接、LaTeX 数学）。Telegram Bot API 只支持有限的 HTML 子集。`formatForTelegramHtml()` 处理转换，包括 LaTeX → Unicode 数学表达式。如果 HTML 解析失败，bot 回退到纯文本。

### 为什么只在触发路径重试沉默？

当用户 @提及或回复 bot 时，沉默几乎总是错误的——用户期望得到回复。用递增提示重试确保模型最终会说话。对于主动插话，沉默是合理的预期选择，不需要重试。

### 进程内状态

对话缓冲区、用户缓存、更新去重集合、主动插话定时器状态全部在进程内存中。重启会丢失所有对话上下文，主动插话检查器也会停止。对于单群组个人 bot 来说这是可接受的。

### 日志架构

日志（`src/libs/logger.ts`）在开发和生产模式下都使用 `pino.multistream()`：

- **开发模式**：将 `pino-pretty` 作为直接 `Transform` 流加载（主线程，无 worker），结合管理员 DM 流转发 warn/error。
- **生产模式**：JSON 输出到 stdout + 管理员 DM 流。

这避免了过去对 `logger.error`/`.warn` 的劫持以及脆弱的 `as unknown as NodeJS.WritableStream` 类型转换。`AdminDmHandler` 返回一个与 pino multistream 兼容的纯 `{ write(msg: string): void }` 适配器。

### 图片缓存时机

图片通过 Gemini 描述后立即在主 handler 中缓存到 Firestore——在 `if (!isMentioned && !isRepliedToBot) return` 判断之前。过去缓存被延迟到 `handleAiTurn()` 中，导致非触发图片被描述但从未缓存。现在确保主动插话上下文始终可用。

### URL 抓取（三级策略）

`fetchUrlContent()`（`ai.ts`）使用三级策略：

1. **Twitter/X** → fxtwitter API（免费，无需认证）+ 批量 Gemini 配图描述
2. **直接抓取** → HTML title/meta 提取
3. **Tavily Extract** → 回退

仅成功结果进入对话缓冲区；失败的抓取静默忽略。原始 URL 绝不进入缓冲区以避免主动噪音。

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
