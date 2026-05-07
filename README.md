# nyarbot

一只傲娇的高中生猫娘 AI，住在你 Telegram 群聊里。

基于 [grammy](https://grammy.dev) 和 [Vercel AI SDK](https://sdk.vercel.ai)，后端接 DeepSeek，用 Firestore 做持久化。

---

## 功能

- 💬 **自然聊天** — @她或回复她就能触发对话，傲娇猫娘口癖（喵、哼！、笨蛋！），会故意念错词（机器人→姬器人，AI→猫工智能）
- 🔍 **链接理解** — 群友分享链接时，自动用 Tavily 提取内容。@她时回复链接内容，没 @ 时写入上下文供主动插话
- 🖼️ **看图吐槽** — 发图片/贴纸，用猫娘视角吐槽或夸夸，图片描述自动缓存到 Firestore
- 🌅 **早安问候** — `/nighty` 或说晚安后，8 小时后下次发言自动收到个性化早安
- 💔 **好人卡** — `/love` 或告白（"我喜欢你""我们结婚吧"）时，根据对你的记忆傲娇地发好人卡
- 🏷️ **昵称 & 记忆** — 跟她说「叫我XX」设置昵称，「记住XXX」记录记忆，她会记住你的事
- 🎯 **主动插话** — 每 15 秒扫描群聊，话题有趣时主动跳进来，活跃时冷却短、冷清时冷却长
- 🎨 **贴纸回复** — 简短对话结束时自动发送 Miaohaha 贴纸
- 🧠 **严肃模式** — 编程/数学/技术问题自动收起猫娘模式，认真回答

---

## 技术栈

| 层 | 库 |
|---|---|
| Telegram Bot 框架 | `grammy` v1 |
| AI / LLM | `ai` (Vercel AI SDK v6) + DeepSeek |
| 网页搜索 | `@tavily/ai-sdk` |
| 数据库 | `firebase-admin` (Firestore) |
| 运行时 | Node.js, TypeScript (ESM, moduleResolution: nodenext) |

---

## 架构

```
src/
├── app.ts                 # 入口：加载 dotenv、初始化 Firebase、注册 handler、启动主动插话
├── configs/
│   └── env.ts             # 环境变量读取（BOT_API_KEY, DEEPSEEK_API_KEY, TG_GROUP_ID 等）
├── handlers/
│   └── index.ts           # message + edited_message 处理器（过滤、命令、触发、AI 路由）
├── libs/
│   ├── ai.ts              # DeepSeek provider、classifyMessage()、generateResponse()、generateLoveRejection()、fetchUrlContent() 等
│   ├── conversation-buffer.ts  # 内存环形缓冲区（最多 30 条），供上下文和主动插话
│   ├── system-prompt.ts   # 猫娘人设 system prompt 构建
│   ├── stickers.ts        # Miaohaha 贴纸包（emoji → file_id 映射）
│   ├── proactive.ts       # 主动插话定时器 + 动态冷却
│   ├── logger.ts          # pino 日志
│   └── index.ts           # barrel 重导出
├── services/
│   ├── index.ts           # Firebase Admin SDK 初始化
│   └── firestore.ts       # Firestore CRUD（用户、图片缓存、晚安/早安时间戳）
└── global.d.ts            # User 类型定义（uid, nickname, memories, ...）
```

**消息处理流程：**

```
消息 → 群组过滤 → 查用户 → 提取文本/图片/贴纸/链接
  ├─ /help → 帮助文本
  ├─ /love → 好人卡
  ├─ /status, /reset → 状态/清缓冲
  ├─ 晚安检测 → 晚安回复
  ├─ 早安检查 → 个性化早安
  ├─ 写入缓冲
  ├─ 未 @ 也未回复 → 链接内容异步写入缓冲 → 结束
  └─ 已 @ 或回复 →
       ├─ 告白检测 → 好人卡
       ├─ await 链接内容 → 注入消息
       └─ 分类 (simple/complex/tech) → 选模型 → stream 回复 + 贴纸
```

---

## 快速开始

```bash
# 1. 安装依赖
npm ci

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 Bot Token、DeepSeek API Key、Tavily API Key 等

# 3. 放入 Firebase 服务账号密钥
# 将 serviceAccountKey.json 放到 src/services/ 下

# 4. 编译
npm run build

# 5. 运行
node dist/app.js
```

---

## 命令列表

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/love` | 向 bot 告白，收获好人卡一张 |
| `/nighty` | 晚安，8 小时后下次发言自动早安问候 |
| `/status` | bot 运行状态（运行时间、缓冲消息数） |
| `/reset` | 清除对话历史缓冲区 |

---

## 自然语言交互

| 场景 | 触发方式 |
|---|---|
| 聊天 | @nyarbot 或回复她的消息 |
| 告白 | 说「我喜欢你」「我们结婚吧」等（需 @ 或回复） |
| 设置昵称 | 跟她说「叫我XX」 |
| 记录记忆 | 跟她说「记住XXX」 |
| 分享链接 | 直接发链接（@她可获得内容总结，不 @ 则写入上下文） |
| 发图片/贴纸 | 直接发送，她看到会评价 |

---

## 配置

所有配置在 `.env` 中：

| 变量 | 必填 | 说明 |
|---|---|---|
| `BOT_API_KEY` | ✅ | Telegram Bot Token |
| `TG_GROUP_ID` | ✅ | 目标群组 ID（bot 只在此群工作） |
| `TG_ADMIN_UID` | ✅ | 管理员 Telegram 用户 ID |
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API Key |
| `TAVILY_API_KEY` | ✅ | Tavily Search API Key |
| `BOT_USERNAME` | ❌ | Bot 用户名，默认 `nyarbot` |
| `LOG_LEVEL` | ❌ | 日志级别，默认 `info` |

---

## 开发

```bash
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
npm run lint       # ESLint 检查
npm run format     # Prettier 格式化
npm run build      # 编译 src/ → dist/
```

保存时通过 Husky + lint-staged 自动运行 prettier 和 eslint。

---

## 免责声明

这是个人项目。bot 的行为和人设为主人定制，如果你选择运行或互动，请自行甄别。
