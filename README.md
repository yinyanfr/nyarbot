# nyarbot

一只傲娇的高中生猫娘 AI，住在你 Telegram 群聊里。

基于 [grammy](https://grammy.dev) 和 [Vercel AI SDK](https://sdk.vercel.ai)，LLM 接 DeepSeek，图片识别接 Gemini（经 Cloudflare AI Gateway），用 Firestore 做持久化。

---

## 功能

- 💬 **自然聊天** — @她或回复她就能触发对话，傲娇猫娘口癖（喵、哼！、笨蛋！），会故意念错词（机器人→姬器人，AI→猫工智能）
- 🧠 **严肃模式** — 编程/数学/技术问题自动收起猫娘模式，认真回答
- 🔍 **联网搜索** — 涉及时事或实时信息时自动搜索（强制搜索机制确保模型不会跳过）
- 🔗 **链接理解** — 推文链接自动通过 fxtwitter API 提取（含 Gemini 配图识别），其他链接先尝试直接抓取标题/描述，再回退到 Tavily；仅成功获取的链接内容写入上下文
- 🖼️ **看图吐槽** — Gemini 识别图片内容（含回复消息中的图片），猫娘视角吐槽或夸夸，描述自动缓存并写入对话上下文供主动插话使用
- 🌅 **早安问候** — `/nighty` 或说晚安后，8 小时后下次发言自动收到个性化早安
- 💔 **好感度告白回应** — `/love` 或告白时根据记忆生成好感度条目并计算总分，再按人设做傲娇回应
- 🏷️ **昵称 & 记忆** — 跟她说「叫我XX」设置昵称，「记住XXX」记录记忆
- 📔 **日记系统** — bot 在群聊中自动记录观察笔记，每日午夜生成一篇猫娘日记，发布到 Hexo 博客
- 🎯 **主动插话** — 两阶段探测：廉价模型判断话题相关性，通过后完整模型生成回复
- 🎨 **贴纸回复** — 通过 emoji 直接选择硬编码贴纸，可单独发或随文字发送
- 🔄 **沉默重试** — 被触发但模型选择沉默时自动重试最多 3 次，附加强制回复提示；仍沉默则发送原始文本或贴纸兜底
- ⌨️ **打字指示** — AI 生成时显示"正在输入…"
- 📝 **Markdown→Telegram HTML** — 回复自动转换 Markdown 粗体/斜体/代码/链接等为 Telegram HTML

---

## 技术栈

| 层                | 库                                                    |
| ----------------- | ----------------------------------------------------- |
| Telegram Bot 框架 | `grammy` v1                                           |
| AI / LLM          | `ai` (Vercel AI SDK v6) + DeepSeek v4                 |
| 图片识别          | Gemini 2.5 Flash (via Cloudflare AI Gateway)          |
| 网页搜索          | `@tavily/ai-sdk`                                      |
| 数据库            | `firebase-admin` (Firestore)                          |
| 日期处理          | `dayjs` (UTC+8, Asia/Shanghai)                        |
| 运行时            | Node.js, TypeScript (ESM, moduleResolution: nodenext) |

---

## 架构

```
src/
├── app.ts                      # 入口：加载 dotenv、初始化 Firebase、注册 handler、
│                               #   创建 ProactiveCallbacks、启动主动插话
├── configs/
│   └── env.ts                  # 环境变量读取与校验
├── handlers/
│   ├── index.ts                # 消息处理器：分类→AI 轮次→发送（含沉默重试、打字指示）
│   ├── context.ts              # BotContext 和 RequestState 类型
│   ├── constants.ts             # 常量（MAX_BUFFER_TEXT、LOVE_REGEX 等）
│   ├── match-command.ts        # 命令匹配工具
│   ├── extract-content.ts      # URL/图片/贴纸提取
│   ├── reply-and-track.ts      # 回复 + 缓冲区推送
│   └── update-dedup.ts         # LRU 去重
├── libs/
│   ├── ai.ts                   # DeepSeek providers、classifyMessage()、
│   │                           #   generateAiTurn()（工具调用架构）、
│   │                           #   probeGate()（主动插话探测）、
│   │                           #   describeImage()、fetchUrlContent() 等
│   ├── conversation-buffer.ts  # 内存环形缓冲区（60 条/组）
│   ├── system-prompt.ts        # 猫娘人设 system prompt、探测 prompt、
│   │                           #   自然度 late-binding prompt
│   ├── stickers.ts             # 贴纸 facade（emoji→file_id 查找 + 随机兜底）
│   ├── format-telegram.ts      # Markdown→Telegram HTML 转换（LaTeX→Unicode）
│   ├── proactive.ts            # 主动插话：ProactiveCallbacks 接口、
│   │                           #   两阶段探测、冷却逻辑、贴纸/打字指示分发
│   ├── diary.ts                # 日记系统：午夜定时器、按日期生成日记
│   ├── time.ts                 # dayjs 时区工具（UTC+8）
│   ├── telegram-image.ts       # Telegram 文件下载 → base64 data URL
│   ├── logger.ts                # pino 日志
│   └── index.ts                # barrel 重导出
├── services/
│   ├── index.ts                # Firebase Admin SDK 初始化
│   ├── firestore.ts            # Firestore CRUD（用户、图片缓存、日记、晚安/早安时间戳）
│   ├── github.ts               # GitHub Content API 推送日记到 Hexo 博客
│   └── serviceAccountKey.json  # Firebase 凭证（gitignored）
└── global.d.ts                 # User、DiaryEntry 类型定义
```

详见 [架构文档](docs/architecture.zh-CN.md)。

---

## 快速开始

```bash
# 1. 安装依赖
npm ci

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 Bot Token、DeepSeek API Key、Tavily API Key、CF AI Gateway Token 等

# 3. 放入 Firebase 服务账号密钥
# 将 serviceAccountKey.json 放到 src/services/ 下

# 4. 编译
npm run build

# 5. 运行
node dist/app.js
```

---

## 命令 & 交互

详见 [命令与交互文档](docs/commands-and-interactions.zh-CN.md)。

| 命令      | 说明                                  |
| --------- | ------------------------------------- |
| `/help`   | 显示帮助                              |
| `/love`   | 向 bot 告白，触发好感度评分与傲娇回应 |
| `/nighty` | 晚安，8 小时后下次发言自动早安问候    |
| `/status` | bot 运行状态（仅管理员）              |
| `/reset`  | 清除对话历史缓冲区（仅管理员）        |
| `/diary`  | 生成今日日记预览（仅管理员，私聊）    |

| 场景        | 触发方式                                           |
| ----------- | -------------------------------------------------- |
| 聊天        | @nyarbot 或回复她的消息                            |
| 告白        | 说「我喜欢你」「我们结婚吧」等（需 @ 或回复）      |
| 设置昵称    | 跟她说「叫我XX」                                   |
| 记录记忆    | 跟她说「记住XXX」                                  |
| 分享链接    | 直接发链接（@她可获得内容总结，不 @ 则写入上下文） |
| 发图片/贴纸 | 直接发送，Gemini 识别后猫娘评价                    |
| 日记记录    | bot 在群聊中自动通过 writeDiary 工具记录观察笔记   |

---

## 配置

详见 [配置文档](docs/configuration.zh-CN.md)。

| 变量                    | 必填 | 说明                                           |
| ----------------------- | ---- | ---------------------------------------------- |
| `BOT_API_KEY`           | ✅   | Telegram Bot Token                             |
| `BOT_PERSONA_NAME`      | ❌   | 机器人对话名，默认 `にゃる`                    |
| `BOT_PERSONA_FULL_NAME` | ❌   | 机器人全名，默认 `晴海猫月`                    |
| `BOT_PERSONA_READING`   | ❌   | 名字读音标注，默认 `はるみ にゃる`             |
| `TG_GROUP_ID`           | ✅   | 目标群组 ID（bot 只在此群工作）                |
| `TG_ADMIN_UID`          | ✅   | 管理员 Telegram 用户 ID                        |
| `DEEPSEEK_API_KEY`      | ✅   | DeepSeek API Key                               |
| `TAVILY_API_KEY`        | ✅   | Tavily Search API Key                          |
| `CF_AIG_TOKEN`          | ✅   | Cloudflare AI Gateway Token（Gemini 图片识别） |
| `CF_ACCOUNT_ID`         | ✅   | Cloudflare 账户 ID（Gemini 图片识别）          |
| `BOT_USERNAME`          | ✅   | Bot 用户名（必须与 Telegram 实际用户名一致）   |
| `GITHUB_TOKEN`          | ❌   | GitHub PAT，用于推送日记到 Hexo 博客           |
| `GITHUB_REPO`           | ❌   | GitHub 仓库名，格式 `owner/repo`               |
| `LOG_LEVEL`             | ❌   | 日志级别，默认 `info`                          |

### 可选高级配置（有默认值）

| 变量                           | 默认值                          | 说明                                      |
| ------------------------------ | ------------------------------- | ----------------------------------------- |
| `DEEPSEEK_BASE_URL`            | `https://api.deepseek.com`      | DeepSeek API 基础地址（可替换代理/网关）  |
| `CF_AIG_GATEWAY`               | `gem`                           | Cloudflare AI Gateway 名称                |
| `GITHUB_API_BASE`              | `https://api.github.com`        | GitHub API 基础地址（GHES 可改）          |
| `GITHUB_API_VERSION`           | `2022-11-28`                    | GitHub API 版本头                         |
| `APP_TIMEZONE`                 | `Asia/Shanghai`                 | 应用时区（IANA 时区名，非法值会启动报错） |
| `LOG_APP_NAME`                 | `nyarbot`                       | 日志服务名                                |
| `ADMIN_DM_MIN_INTERVAL_MS`     | `5000`                          | 管理员日志私信最小间隔（毫秒）            |
| `CONVERSATION_BUFFER_PATH`     | `data/conversation-buffer.json` | 对话缓冲持久化文件路径                    |
| `BOT_MESSAGE_DELAY_MS`         | `400`                           | bot 被动回复多条消息时的间隔（毫秒）      |
| `PROACTIVE_CHECK_INTERVAL_MS`  | `15000`                         | 主动发言轮询间隔（毫秒）                  |
| `PROACTIVE_WINDOW_MS`          | `180000`                        | 主动发言观察窗口（毫秒）                  |
| `PROACTIVE_MESSAGE_DELAY_MS`   | `400`                           | 主动发言多条消息间隔（毫秒）              |
| `PROACTIVE_MAX_FAILURES`       | `5`                             | 主动发言连续失败停止阈值                  |
| `PROACTIVE_COOLDOWN_HIGH_MS`   | `90000`                         | 高活跃冷却（毫秒）                        |
| `PROACTIVE_COOLDOWN_MEDIUM_MS` | `180000`                        | 中活跃冷却（毫秒）                        |
| `PROACTIVE_COOLDOWN_LOW_MS`    | `360000`                        | 低活跃冷却（毫秒）                        |
| `DIARY_CHECK_INTERVAL_MS`      | `60000`                         | 日记跨天检查间隔（毫秒）                  |
| `BUFFER_SAVE_INTERVAL_MS`      | `300000`                        | 对话缓冲自动保存间隔（毫秒）              |

---

## 开发

详见 [开发文档](docs/development.zh-CN.md)。

```bash
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
npm run lint       # ESLint 检查
npm run format     # Prettier 格式化
npm run build      # 编译 src/ → dist/
```

保存时通过 Husky + lint-staged 自动运行 prettier 和 eslint。

---

## 文档

- [架构文档](docs/architecture.zh-CN.md) — 工具调用架构、主动插话两阶段探测、沉默重试、Markdown 渲染
- [Prompt XML Schema](docs/prompt-xml-schema.md) — prompt 与上下文 XML 标签约定
- [配置文档](docs/configuration.zh-CN.md) — 环境变量、Firebase、模型选择、AI Gateway
- [命令与交互](docs/commands-and-interactions.zh-CN.md) — 命令、自然语言触发、LLM 工具、沉默重试
- [开发文档](docs/development.zh-CN.md) — 设计决策、Firestore schema、常见问题

English docs:

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Commands & Interactions](docs/commands-and-interactions.md)
- [Development](docs/development.md)

---

## 免责声明

这是个人项目。bot 的行为和人设为主人定制，如果你选择运行或互动，请自行甄别。
