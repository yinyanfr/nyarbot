# 开发

## 前置条件

- Node.js 24+（CI 工作流要求）
- npm

## 安装

```bash
npm ci
cp .env.example .env
# 编辑 .env 填入你的密钥
```

生产环境不需要 Firebase 凭据。`src/services/serviceAccountKey.json` 只在切换前供一次性迁移工具使用。

## 脚本

```bash
npm run typecheck   # tsc --noEmit（类型检查）
npm run build       # tsc（编译 src/ → dist/）
npm run lint        # eslint .
npm run format      # prettier --write .
node dist/app.js    # 运行编译后的 bot
```

Pre-commit 钩子（Husky + lint-staged）自动格式化和检查暂存的 `.ts` 文件。

## Prompt 协议

Prompt 与动态上下文的 XML 标签约定见 `docs/prompt-xml-schema.md`。

## CI

GitHub Actions（`.github/workflows/ci.yml`）在 push/PR 到 `main`/`master` 时运行：

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run format:check`

`npm test` 会先构建项目，再运行数据库备份测试。

## 关键设计决策

### 为什么用工具调用架构而不是流式回复？

之前的流式架构（`streamText` + `sendMessage` + `editMessageText`）直接输出文本。工具调用架构（`generateText` + `send_message`/`dismiss` 工具）让沉默成为第一类结构化选择——模型必须显式调用 `send_message` 才能说话。这重塑了概率分布，减少了不必要的 AI 啰嗦。内心独白（没有工具调用的原始文本输出）被视为"dismiss"并附带可选的 `rawText` 兜底。

其他好处：

- **贴纸分发**：`sendSticker` 工具让模型通过 emoji 选择硬编码贴纸；无效 emoji 会取消发送。
- **记忆工具**：`saveMemory`、`setNickname`、`deleteMemory` 是带 uid 验证的一等操作。
- **沉默重试**：当被触发但被 dismiss 时，handler 可以用递增的提示重试。

### 为什么分类用 `generateText` 而不是 `generateObject`？

分类要求 GLM-4.7-FlashX 返回一个很小的原始 JSON 对象，再用 Zod 校验；这一无 schema 依赖路径便于确定性处理失败。

### 为什么使用 OpenAI chat model 集成？

文本主模型通过 `@ai-sdk/openai` 接入 z.ai 海外 OpenAI-compatible API。GLM-4.7-FlashX 关闭思考；可选 DeepSeek advisor 另行使用 OpenAI-compatible Chat Completions 并开启思考。

### 为什么用两阶段主动探测？

每次主动检查都运行完整 turn 很浪费。探测门使用关闭思考的 GLM-4.7-FlashX，配合简化提示词和只有 `dismiss`/`send_message` 的工具。探测认为话题相关后才运行完整 turn。最近一次 bot 输出之后的消息才是候选；`activityRevision` 快照会在出现新活动时取消结果。

### 为什么用 `formatForTelegramHtml`？

DeepSeek 输出 Markdown（粗体、斜体、代码、链接、LaTeX 数学）。Telegram Bot API 只支持有限的 HTML 子集。`formatForTelegramHtml()` 处理转换，包括 LaTeX → Unicode 数学表达式。如果 HTML 解析失败，bot 回退到纯文本。

### 为什么只在触发路径重试沉默？

当用户 @提及或回复 bot 时，沉默几乎总是错误的——用户期望得到回复。用递增提示重试确保模型最终会说话。对于主动插话，沉默是合理的预期选择，不需要重试。

当前实现的重试次数是：simple/complex 最多 1 次，tech 0 次。技术问题如果模型选择沉默，直接走兜底，避免昂贵模型重复消耗。

### 为什么有单群 Runtime？

handler 仍负责 Telegram 细节，但 AI 调度统一交给 `groupRuntime`。这样可以保证 passive/proactive 不并发、群聊白热化时不抢话、刷屏用户不会触发大量模型调用，并且每轮模型输入/输出、工具调用、token usage 都能写入 SQLite 供调试。

Runtime 的默认阈值：

- debounce：首次 5 秒，新触发延长 5 秒，30 秒硬上限
- hot chat：30 秒内 10 条真实用户消息
- quiet mode：触发后 180 秒
- 单用户限流：30 秒内超过 8 条非命令消息，冷却 60 秒
- URL flood：60 秒内超过 3 个 URL，禁用搜索/抓链接触发
- 媒体 flood：60 秒内超过 5 个媒体，禁用媒体描述 5 分钟

`/roll` 使用 `scheduleCommandTurn()`：程序解析和数值结果保持立即响应，AI 跟进则与 passive/proactive 轮次串行。`/nighty` 也在普通用户/媒体处理之前走快速路径，并在后台持久化时间戳。

### 为什么静态 system prompt？

主模型调用采用 KV cache 友好布局：

```text
system:
  static persona + static behavior rules + static XML/tool guidance

user:
  <conversation_summary_untrusted>
  <recent_history_untrusted>
  <retrieved_or_selected_memories>
  <current_turn>
  <late_binding>
```

`buildSystemPrompt()` 不应包含当前时间、用户记忆、最近历史、runtime 状态或自然度反馈。这些动态内容放在 user message 尾部，尤其是 `buildLateBindingPrompt()`。工具 schema 也尽量稳定；工具不可用时返回禁用原因，而不是从 schema 中消失。

### 为什么 compaction 不是 diary？

Compaction 是机器人工作记忆：保留活跃话题、长期事实、待跟进事项和机器人已经做过的搜索/解释，写入 `compactions` 和 `runtime/group.summary`。它会作为不可信摘要进入 prompt。

Diary 是文学化归档：由 `writeDiary` 和午夜日记流程生成，面向阅读，不参与 runtime cursor，也不替代工作记忆。

### 为什么有日记系统？

Bot 通过 `writeDiary` 写入结构化 `DiaryObservationV2`，并可携带稳定的 subject identity。定时器会在 00:02 后扫描最近三个已结束日期，且启动时立即检查。Gemini 3.1 Pro Preview 优先选择 active observations 生成第一人称日记；如果没有观察通过筛选，则依次使用旧日记条目和 runtime 持久化事件的首尾限量样本。昨日最终词云会复用于 Telegram/博客发布；GitHub blobs、tree、Markdown 和图片通过一次 Git Data API commit 批量提交。只有已配置且 GitHub 发布成功才检查 Pages；无论发布是否可用，Gemini 3.5 Flash-Lite 都会通读全文生成群通知导读。

### 为什么用 dayjs 处理日期？

`dayjs`（2KB）被选为日期库，而非 `date-fns`、`luxon` 或 `Temporal`，原因：

- 体积最小且支持时区
- 插件系统（`utc` + `timezone` 插件）
- Moment.js 兼容 API（熟悉、简洁）
- 所有时区感知的格式化集中在 `src/libs/time.ts`，时区由 `APP_TIMEZONE` 配置（默认 `Asia/Shanghai`）

### 进程内状态

对话缓冲区、用户缓存、更新去重集合、主动插话定时器状态仍在进程内存中，但对话恢复和调试不再只依赖缓冲区。SQLite `runtime_events` 是 append-only 事实记录，`runtime_group` + recent events 是长期上下文来源；内存 buffer 是热缓存和快速扫描窗口。

### 日志架构

日志（`src/libs/logger.ts`）在开发和生产模式下都使用 `pino.multistream()`：

- **开发模式**：将 `pino-pretty` 作为直接 `Transform` 流加载（主线程，无 worker），结合管理员 DM 流转发 warn/error。
- **生产模式**：JSON 输出到 stdout + 管理员 DM 流。

这避免了过去对 `logger.error`/`.warn` 的劫持以及脆弱的 `as unknown as NodeJS.WritableStream` 类型转换。`AdminDmHandler` 返回一个与 pino multistream 兼容的纯 `{ write(msg: string): void }` 适配器。

### 按需媒体处理

Handler 只保留 Telegram 原始 `file_id` / `thumbnail_file_id`，不再预描述媒体。Gemini 3.5 Flash-Lite 在被动触发轮次按需查看完整图片或媒体缩略图，主动轮次也可预取最新候选图片。视频贴纸不会下载、转码或作为视频发送；只在需要时描述 Telegram 预览缩略图，否则保留 emoji / 轻量标记。下载文件先按字节识别 MIME；成功描述只进入有容量上限的进程内会话缓存。

### URL 抓取（三级策略）

`fetchUrlContent()`（`ai.ts`）使用三级策略：

1. **Twitter/X** → fxtwitter API（免费，无需认证）+ 批量 Gemini 3.5 Flash-Lite 配图描述
2. **直接抓取** → HTML title/meta 提取
3. **Tavily Extract** → 回退

URL 摘要只做进程内缓存；历史会保留轻量 URL 标记，但主动路径不抓取 URL 内容。

## 统一 SQLite Schema

`src/services/database.ts` 负责 schema 初始化与版本，`src/services/persistence.ts` 负责应用 CRUD。默认数据库是 `data/nyarbot.sqlite`。

### Users

```typescript
interface User {
  uid: string;
  nickname: string;
  memories: string[]; // 最多 30 条，最新的在最后
  nightyTimestamp?: number; // 毫秒时间戳
  lastMorningGreet?: number; // 毫秒时间戳
}
```

### 日记集合

```typescript
interface DiaryEntry {
  ts: number;
  content: string;
}

// 省略了部分可选内容/来源字段，完整定义见 src/global.d.ts。
interface DiaryObservationV2 {
  schemaVersion: 2;
  id: string;
  recordedAt: string;
  localDate: string;
  subjectUid?: string;
  subjectName?: string;
  subjectUsername?: string;
  event: string;
  confidence: "fact" | "inference" | "uncertain";
  salience: 1 | 2 | 3 | 4 | 5;
  status: "active" | "superseded" | "retracted";
}

// diary 表中以日期为键的记录
// entries?: DiaryEntry[]（旧格式回退）
// diary?: string（生成的日记文本）
// generatedAt?: number（毫秒时间戳）
// generationRecords?: DiaryGenerationRecord[]

// diary_observations 表中以 id 为键的 DiaryObservationV2
```

## 词云发布

本地 SQLite 会记录中午、晚间和昨日最终版三个发布 slot。运行期间，12:00–17:59 尝试中午场，18:00 后尝试晚间场；错过的中午场不补发。生成文件保存在 `wordcloud-artifacts/`，生成/发布最多重试三次；昨日最终图片会被日记频道与 GitHub 发布复用。

### Runtime tables

```typescript
// runtime_group
interface RuntimeGroupStateDoc {
  summary: string;
  summaryCursorTs: number;
  lastProcessedMessageId?: number;
  lastCompactedAt?: number;
  updatedAt: number;
}

// runtime_events
interface RuntimeEventRecord {
  chatId: string;
  messageId?: number;
  updateId?: number;
  kind: "user_message" | "edited_message" | "bot_message" | "command" | "system";
  uid: string;
  name: string;
  text: string;
  mediaRefs: unknown[];
  urls: string[];
  ts: number;
  ignoredReason?: string;
}

// runtime_turns
// stores model, tier, needsSearch, tool calls, action, messages, token/cache usage, latency, error.

// runtime_compactions
// append-only compaction snapshots with oldCursorTs/newCursorTs and token usage.
```
