# 架构

nyarbot 是一个用 TypeScript (ESM) 编写的 Telegram 机器人，拥有单个目标群 runtime、独立管理员私聊路径和可配置猫娘人设。

## 单群 Runtime

群聊交互只服务 `TG_GROUP_ID`，支持的管理员私聊命令独立处理。AI 调度不再由 handler 直接启动；`src/libs/group-runtime.ts` 是单群 runtime，负责：

- message-level dedup：按 `chatId + messageId + editDate` 去重，补足 Telegram `update_id` 去重之外的语义。
- abuse gates：重复文本、单用户突发刷屏、URL flood、媒体 flood 会被记录为 `ignoredReason`，被限流的消息不会触发模型。
- debounce：被 @ 或回复触发后先等群聊安静，默认 5 秒；新触发会延长，30 秒硬上限。
- `running` / `dirty` lock：同一时间最多一个 passive/proactive AI turn；运行中有新触发时只标脏，结束后再排队判断。
- quiet mode：30 秒内真实用户消息达到阈值后进入 3 分钟安静模式；主动插话暂停，普通非 @ / 非回复不触发。
- Firestore append-only 记录：`events`、`turns`、`compactions` 和 `runtime/group` 是恢复、调试与 compaction 的来源。

## 数据流

```
Telegram Update
    │
    ▼
app.ts（入口：初始化 Firebase、创建 Bot、注册 handler、启动主动插话检查器）
    │
    ▼
handlers/index.ts（setupHandlers）
    │
    ├─ 更新去重（update-dedup.ts）
    ├─ 管理员私聊分支
    │     ├─ /status、/reset、/diary、/wordcloud
    │     └─ /diaryobs、/diaryshow、/diaryedit、/diaryretract、/diaryregen
    ├─ 目标群过滤（tgGroupId）
    ├─ 群内快速命令
    │     ├─ /nighty → 立即确认 + 后台写入时间戳
    │     └─ /roll → 立即报结果；后台提取内容并 scheduleCommandTurn()
    ├─ 用户解析（firestore.ts → 60秒进程内缓存）
    ├─ 内容提取（extract-content.ts）
    │     ├─ URL 检测（entity + 正则回退）
    │     └─ 保留原始 file_id / thumbnail_file_id / 贴纸 emoji 引用
    ├─ 本地词云持久化（local-wordcloud-store.ts）
    │     ├─ 仅目标群活人消息
    │     ├─ 命令消息跳过；编辑成命令时删除旧记录
    │     ├─ 编辑消息按相同 message_id 覆盖
    │     └─ 转发消息打标，仅参与活跃榜不参与词云正文
    ├─ 缓冲区推送（conversation-buffer.ts；原始媒体/链接标记）
    ├─ 命令路由（match-command.ts）
    │     └─ /help、/love、/shock、/stroke
    ├─ 早安逻辑 → generateMorningGreeting()
    ├─ 触发检测（@提及 / 回复bot）
    ├─ 本地路由（短聊 / 技术 / 当前事实）
    ├─ AI 分类（classifyMessage）
    │     └─ simple → flashNoThinkModel
    │     └─ complex → flashThinkModel
    │     └─ tech → proThinkModel
    ├─ Runtime 调度（group-runtime.ts）
    │     ├─ 事件持久化、去重、限流、debounce、running lock
    │     └─ 构造 summary + recent events 上下文
    ├─ AI 轮次（handleAiTurn → generateAiTurn）
    │     ├─ 静态系统提示词（buildSystemPrompt）
    │     ├─ 用户消息尾部 late-binding（当前时间、触发态、工具可用性、runtime 状态）
    │     ├─ 工具调用：send_message、dismiss、saveMemory、setNickname、
│     │           deleteMemory、sendSticker、writeDiary、webSearch、
│     │           describeTelegramMedia、fetchUrlContent、startSubagent
    │     ├─ 富内容按需读取；只做会话缓存，不写 Firestore 图片缓存
    │     │     ├─ 图片使用原文件，其他媒体/贴纸优先缩略图
    │     │     └─ 已知字节签名优先，未命中时接受 image/* 响应头
    │     ├─ 搜索预取：先在模型前做一次 webSearch，成功则视为本轮已搜索
    │     ├─ 搜索策略违规重试（needsSearch 但未搜索且已准备发言时重试一次）
    │     ├─ 沉默重试（simple/complex 1 次；tech 0 次）
    │     ├─ raw draft rescue：dismiss 后尽量用真实 send_message 把草稿改写后补发
    │     ├─ 格式化输出（formatForTelegramHtml：Markdown → Telegram HTML）
    │     └─ 通过 sendAiMessages 发送（打字指示、消息间隔、贴纸分发）
    └─ 主动插话检查器（proactive.ts，间隔可由环境变量配置）
          ├─ 最新 bot 输出之后才是候选消息窗口
          ├─ 阶段一：probeGate() — 廉价模型判断话题相关性
          ├─ 阶段二：generateAiTurn() — 完整模型生成回复
          └─ 发送前及多消息之间检查 activity revision，取消过时输出
```

## 工具调用架构

Bot 不再流式输出原始文本，而是使用**工具调用架构**：模型必须显式调用 `send_message` 才能说话。原始文本输出被视为内心独白（用户不可见）。这重塑了概率分布——沉默是通过 `dismiss` 工具的结构化选择，而不仅仅是提示词指令。

### 可用工具

| 工具                    | 用途                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `send_message`          | 向群聊发送消息（必须调用才能说话；可多次调用）                                 |
| `dismiss`               | 选择不回复（二选一：说话/沉默）                                                |
| `saveMemory`            | 记录关于群友的记忆（uid 须来自最近群友列表）                                   |
| `setNickname`           | 设置/更新群友的昵称                                                            |
| `deleteMemory`          | 删除关于群友的指定记忆                                                         |
| `sendSticker`           | 通过 emoji 直接选择硬编码贴纸。无效 emoji 会取消贴纸发送，不再回退到智能选择。 |
| `describeTelegramMedia` | 被动触发时按需描述媒体；主动路径仅可查看最新候选中选出的图片。                 |
| `fetchUrlContent`       | 按需抓取当前轮 URL 内容摘要（仅被动触发轮次可用）。                            |
| `writeDiary`            | 在 Firestore `diaryObservations` 创建、更新或撤回结构化观察。                  |
| `webSearch`             | Tavily 搜索。工具 schema 保持稳定；若输入层禁用搜索，工具返回禁用原因。        |
| `startSubagent`         | 启动一次性 helper 处理 URL/媒体/技术检索，返回短摘要，不能直接发群消息。       |

### AiTurnResult

```typescript
type AiTurnResult =
  | { action: "send"; messages: string[]; stickerFileId: string | null }
  | { action: "dismiss"; rawText?: string };
```

- **`send`**：一条或多条消息 + 可选贴纸（file_id）。通过 `sendAiMessages()` 发送，该方法会将 Markdown 格式化为 HTML、错开消息时间（400ms）、直接按 file_id 分发贴纸。
- **`dismiss`**：模型选择沉默。`rawText` 捕获内心独白作为重试的兜底。

### 沉默重试

当 bot 被触发（@提及或回复）但模型选择 `dismiss` 时，handler 对 simple/complex 最多重试 1 次，tech 不重试。重试追加提示：

> `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]`

如果所有重试仍然沉默：

- 如果 `rawText` 存在 → 先尝试救成真实 `send_message`；成功时只发送救回的消息，不附贴纸
- 如果 rescue 失败 → 发送原始草稿 + 随机贴纸
- 如果 `rawText` 为空 → 只发送随机贴纸（作为回复）

## AI 模型路由

| Provider/model                                  | 用途                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| DeepSeek v4 Flash，无思考                       | 分类、短聊、早安/告白/互动反应、主动探测               |
| DeepSeek v4 Flash，有思考                       | 复杂对话与工具调用轮次                                 |
| DeepSeek v4 Pro，有思考                         | 技术问题与 advisor-heavy 轮次                          |
| Gemini 3.5 Flash-Lite（Cloudflare AI Gateway）  | DeepSeek 回复回退、Telegram/推文图片理解、完整日记导读 |
| Gemini 3.1 Pro Preview（Cloudflare AI Gateway） | 午夜日记生成、管理员 `/diary` 预览                     |

### 为什么用两个提供商？

- **DeepSeek v4** 不支持视觉能力。发送 `image_url` 内容部分会返回 400 错误。
- **Gemini 3.5 Flash-Lite** 经 Cloudflare AI Gateway 处理 DeepSeek 不可用时的回复回退、图片理解和日记通知；**Gemini 3.1 Pro Preview** 负责写日记。
- 一轮回复会粘在同一提供商上：如果首个 DeepSeek step 触发回退，后续工具 step 全部继续使用 Gemini，以保留有效 thought signature；DeepSeek 已经发出工具调用后不会再中途切换。网络/超时、401–403、408/409/429 和 5xx 会触发回退；错误请求 400 和正常 `dismiss` 不会触发。

## 本地路由

不是所有触发轮次都先跑 `classifyMessage()`。handler 会先做一层轻量本地判断：

- 短促闲聊会直接路由到 `simple`
- 技术/数学/学术信号会直接路由到 `tech`
- 明确要求“认真/详细/解释”的请求会更偏向 `complex` + `preferAdvisor`
- 当前事实查询会直接标记 `needsSearch`
- 轻贴纸闲聊会关闭本轮持久化工具，避免无意义写记忆/写日记

`preferAdvisor` 只是提示主轮次先调用 `startSubagent` 取摘要，helper 不能直接发群消息。普通触发轮次仍然可以写记忆和日记。

## 超时保护

所有关键模型调用都带总超时，避免单轮卡住 `typing` / `running`：主模型、subagent、视觉描述、日记生成和外部 fetch 都有超时兜底。

### 强制联网搜索

当 `classifyMessage()` 返回 `needsSearch=true` 时，late-binding 会追加强制搜索要求。若模型在没有调用 `webSearch` 的情况下调用了 `send_message`，本轮视为策略违规：自动重试一次并追加更硬的搜索提示；若仍失败，发送保守失败文案，避免凭记忆乱答。
如果本轮在模型生成前已经完成了成功的预取搜索，则这次预取视为“已经搜索过”；只有结果仍不足时，才需要再额外调用 `webSearch`。

> `<强制指令：这条消息涉及需要最新/实时信息的内容，你必须先调用 webSearch 工具搜索后再回答。不要凭记忆回答，务必搜索。>`

这防止模型跳过搜索工具调用。

## 上下文管理

- **Runtime events**：Firestore `events` 是恢复、调试和 compaction 的主要来源，append-only 保存用户消息、编辑、命令、bot 输出和忽略原因。
- **对话缓冲区**：内存环形缓冲区仍保留为热缓存和 proactive 快速扫描窗口；它不是唯一上下文来源，重启恢复依赖 Firestore runtime events 与 `runtime/group.summary`。
- **用户数据**（昵称、记忆、晚安/早安时间戳）：持久化到 Firestore，进程内缓存 60 秒。
- **富内容缓存**：媒体描述与链接摘要使用进程内会话缓存（TTL + 容量上限），不持久化到 Firestore。
- **Compaction**：当 recent events 超过阈值时，runtime 使用模型生成 `# 群聊长期摘要`，写入 `compactions` 并更新 `runtime/group.summary` 与 `summaryCursorTs`。摘要注入 prompt 时标记为不可信。Compaction 是工作记忆，diary 是文学归档，二者分离。

## 词云流水线

- `src/services/local-wordcloud-store.ts` 用 SQLite 保存最近 10 天群消息和词云发布记录。
- `src/libs/wordcloud.ts` 负责分词、词频统计、布局、渲染和发布。
- 运行期间，12:00–17:59 尝试中午场，18:00 后尝试晚间场，通过 SQLite slot marker 去重；错过的中午场不补发。
- 00:02 后发布昨日最终版，重启后也会 catch up。
- PNG 保存在 SQLite 同目录的 `wordcloud-artifacts/`，生成/发布最多重试三次；昨日最终版会复用于日记发布。
- 词频对单条消息按集合去重，同一条消息里相同词只算 1 次。
- 正文词云会过滤转发文本、明显负面词和常见虚词；活跃榜仍统计转发消息。
- 渲染内置完整 Source Han Sans 可变字体，保证简中、繁中、日文、韩文不掉成方块字。
- 当前默认布局是“中心骨架优先”：高频词先占中间，少量短中文词可竖排补缝。

## 记忆与日记

- `saveMemory` 现在更偏向“以后大概率还会用到的用户事实”，不必要求它是永久设定。
- `writeDiary` 更偏向收集当天值得回看的候选观察，而不是只记特别重大的事件。
- `memoryCandidateHints` 是 handler 提供的软提示，只用于提高相关命中，不是自动写入依据。

## 提示词架构

### 系统提示词（`buildSystemPrompt`）

完全静态，适合 KV cache，包含：

- 人设（名字/读音/身份来自环境变量）与自然度指南（基于真人 vs AI 群聊对比分析）
- 工具调用规则、群聊行为规则、安全边界
- 不包含当前时间、当前用户、记忆、历史、runtime 状态

### 晚绑定提示词（`buildLateBindingPrompt`）

每轮追加动态反馈：

- bot 是否被 @或回复
- 当前时间
- 搜索/媒体工具是否被 runtime 允许
- hot chat / quiet mode / flood protection 状态
- 当 `needsSearch=true` 时的 mandatory search 提示
- 自然度反馈：如果最近的 bot 消息过多以 `。` 结尾，或平均长度 > 40 字，则注入提醒

### 探测提示词（`buildProbeSystemPrompt`）

主动插话探测门的精简变体——只有人设，没有按用户记忆或自然度指南。

## 消息输出管道

1. **`generateAiTurn()`** 返回 `AiTurnResult`（`send` 或 `dismiss`）
2. **沉默重试**（仅触发路径）：simple/complex 1 次，tech 不重试
3. **`sendAiMessages()`**：
   - 通过 `formatForTelegramHtml()` 格式化每条消息（Markdown → Telegram HTML，LaTeX → Unicode）
   - 第一条消息回复用户消息；后续消息独立发送
   - 消息间隔由环境变量配置（默认 400ms，模拟人类打字节奏）
   - 所有文本消息后分发贴纸（或纯贴纸带回复引用）
   - 如果 HTML 解析失败，回退到纯文本
4. **缓冲区推送**：每条发送的消息推送到对话缓冲区

## 主动插话（两阶段探测）

`proactive.ts` 通过环境变量配置的间隔和窗口检查缓冲区历史（默认每 15 秒检查最近 3 分钟）：

| 活跃度       | 最近用户消息数 | 冷却时间 |
| ------------ | -------------- | -------- |
| 高（≥7 条）  | ≥7             | 90 秒    |
| 中（3-6 条） | 3-6            | 180 秒   |
| 低（1-2 条） | 1-2            | 360 秒   |

冷却结束后，checker 先找到最近一次 bot 输出，只把其后的用户消息当作可回复候选，之前的历史只能参考。摄取或命令轮次运行时不启动主动回复，并记录 activity revision，在 probe 后、发送前和多消息之间重复校验。

1. **阶段一——探测**：`probeGate()` 使用廉价模型（`flashNoThink`）配合 `buildProbeSystemPrompt()` 和轻量 `dismiss`/`send_message` 工具。若探测沉默或活动已变化，停止。
2. **阶段二——完整模型**：若探测激活，`generateAiTurn()` 关闭持久化工具，仅按候选图片情况开放视觉理解；任何新的用户或 bot 活动都会使结果失效。

主动路径使用 `ProactiveCallbacks` 接口（`sendText`、`sendSticker`、`sendChatAction`）来格式化消息、分发贴纸和显示打字指示——与 handler 路径的格式化保持一致。

主动插话遇到暂时故障时采用有上限的指数退避。任何未抛错的检查（包括合理保持沉默）都会清零连续失败计数；除非显式关闭，检查器会持续调度。管理员 `/status` 会显示其定时器、失败次数、时间戳和最近错误。

## 日记系统

Bot 通过 `writeDiary` AI 工具记录结构化对话观察。Compaction 始终是独立的工作记忆，不会替代日记归档。

### 观察记录

- `writeDiary` 在 `diaryObservations` 中创建、更新、取代或撤回 `DiaryObservationV2`。
- 记录包含事件、即时反应、解释、置信度、显著性、状态，以及可选的稳定 subject uid/name/username 快照。
- 去重会考虑 subject uid，避免把不同人物的观察误合并。

### 午夜生成

一个可配置间隔的定时器（`checkAndGenerateDiary`，在 `src/libs/diary.ts` 中，默认 60 秒）基于 `APP_TIMEZONE` 检查日期。启动时会立即运行并扫描最近三个已结束日期，因此重启后可以补生成近期缺失日记：

1. 00:02 后选取最多 12 条 active observations；若没有观察通过筛选，则依次回退到旧的 `diary/{date}.entries` 和当天持久化 runtime `events` 的限量样本。
2. Gemini 3.1 Pro Preview 生成日记，并将正文和生成记录（模型、prompt/style 版本、观察 id、usage/status）写入 Firestore。
3. 生成或复用昨日词云。推送 Telegram 频道时，日记不超过 1024 字符则作为图片 caption，否则图片后另发正文。
4. GitHub 发布通过 blobs/tree/commit 一次提交 Markdown 与可选的 `source/img/diary/` 图片，再非 force 更新 `main`；Markdown 使用 `/img/diary/...` 根路径。
5. 如果已配置且 GitHub 发布成功，先等待 Pages；无论 GitHub 是否可用，Gemini 3.5 Flash-Lite 都会通读全文生成 1–2 句克制导读，链接状态与题库文案由程序固定拼接。

### 日记管理员命令

管理员私聊提供 `/diary`、`/diaryregen [date]` 预览，以及 `/diaryobs`、`/diaryshow`、`/diaryedit`、`/diaryretract` 观察管理。预览/重新生成不会保存或发布日记正文。

### Firestore Schema

```
diary/{YYYY-MM-DD}
  ├── entries?: DiaryEntry[]              （旧格式回退）
  ├── diary?: string
  ├── generatedAt?: number
  └── generationRecords?: DiaryGenerationRecord[]

diaryObservations/{id}
  └── DiaryObservationV2
```

### 时区

所有日期格式化使用环境变量配置的时区（`APP_TIMEZONE`，默认 `Asia/Shanghai`），集中在 `src/libs/time.ts` 中通过 `dayjs` 实现。函数：`todayDateStr()`、`yesterdayDateStr()`、`formatTimestamp()`、`formatSystemPromptTime()`。
