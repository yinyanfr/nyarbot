---
title: 源码地图与练习命令
description: 按目录找到真实源码，在不接入生产服务的情况下运行章节测试。
---

课程代码、行号和测试基于 [发布提交 `2433dea`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1)。提交是仓库在某一时刻的版本；固定版本可以让网页的行号和你的练习对应。只读源码时点链接即可，不需要安装任何东西。

## 先找到负责的目录

`src/` 放 TypeScript 源码；`dist/` 是编译后交给 Node.js 运行的 JavaScript；`*.test.ts` 是测试。`website/` 是这门课程本身。要读一条消息，优先找 handler 的入口；遇到「模型没发言」，用函数名 `generateAiTurn` 和 `sendAiMessages` 分别追踪生成与投递。

| 目录                                                                                                              | 找什么                                     | 读完去哪里                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| [`src/handlers/`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers) | Telegram 入口、内容提取、触发和投递        | [消息链路](../message-to-reply/)                      |
| [`src/libs/`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs)         | Runtime、模型与工具、提示词、MCP、后台日记 | [Agent 与 Harness](../agent-harness/)、[MCP](../mcp/) |
| [`src/services/`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services) | SQLite、结构化记忆、向量索引和 GitHub 发布 | [RAG](../memory-rag/)、[日记案例](../diary/)          |

## 第一次在终端运行

准备 Git 和 Node.js 24.19.0（与课程版本的 CI 一致），用 `node --version` 检查。下面在一个新的练习目录克隆固定提交，从该仓库根目录执行，以免改变你已有工作副本的版本：

```sh
git clone https://github.com/yinyanfr/nyarbot.git nyarbot-course
cd nyarbot-course
git switch --detach 2433deab6c72ea1ccc44b39c22887badfd638fa1
npm ci
npm run build
```

`npm ci` 用仓库锁定的版本安装依赖，`npm run build` 将 `.ts` 编译成 `.js`。这里只运行测试，不需要创建 `.env` 或启动机器人。`--import=./dist/test-setup.js` 在加载测试前准备测试配置；`--test-name-pattern` 按名称挑选想运行的测试。先跑「先查再答」：

```sh
node --import=./dist/test-setup.js --test \
  --test-name-pattern='real SDK loop feeds recall results' dist/libs/ai.test.js
```

输出应包含测试名称和 `pass`，没有 `fail`。如果没有看到对应测试名称，先检查筛选字符串是否拼对；如果提示找不到 `dist` 文件，确认当前目录是 `nyarbot-course` 并成功编译。测试里 `assert.equal(实际值, 期望值)` 的意思是两者必须相等；失败时对照报出的实际值和预期值。

## 按问题选择测试

用表中的片段和文件替换上面命令中 `--test-name-pattern` 的值和最后的路径。去掉名称筛选，就会运行同一文件里的所有测试。

| 想验证什么                             | 测试名称片段                             | 编译后文件                                |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| 已判为重复的消息是否进入 runtime？     | `deduplicates before user/runtime work`  | `dist/handlers/index.test.js`             |
| 已有回合时，新触发如何等待？           | `marks dirty`                            | `dist/libs/group-runtime.test.js`         |
| 先查再答：模型下一步能看到工具结果吗？ | `real SDK loop feeds recall results`     | `dist/libs/ai.test.js`                    |
| 同一步的抢答会被保留吗？               | `requires a later step before sending`   | `dist/libs/ai.test.js`                    |
| 资料里的标签怎么处理？                 | `session context filters injection`      | `dist/libs/system-prompt.test.js`         |
| 语义与字面召回能一起工作吗？           | `hybrid finds paraphrases`               | `dist/services/memory-embeddings.test.js` |
| 无字幕时能得到什么？                   | `falls back from transcript to metadata` | `dist/libs/video.test.js`                 |
| 哪些模型错误可回退？                   | `fallback uses Gemini only`              | `dist/libs/ai.test.js`                    |
| Pages 恢复后会重发导读吗？             | `a Pages failure does not block`         | `dist/libs/diary.test.js`                 |

课程测试用替代实现和隔离数据验证程序路径。例子里的「测试通过」表示程序满足写下的断言，不表示连过真实聊天群，也不表示某个在线模型会产生完全相同的文字。通常先看测试断言，再沿它调用的函数去看实现，比一开始通读整个文件更容易。

## 项目参考文档

- [运行架构](https://github.com/yinyanfr/nyarbot/blob/main/docs/architecture.zh-CN.md) · [提示词 XML 结构](https://github.com/yinyanfr/nyarbot/blob/main/docs/prompt-xml-schema.md)
- [开发与测试](https://github.com/yinyanfr/nyarbot/blob/main/docs/development.zh-CN.md) · [环境配置](https://github.com/yinyanfr/nyarbot/blob/main/docs/configuration.zh-CN.md)
- [命令与交互](https://github.com/yinyanfr/nyarbot/blob/main/docs/commands-and-interactions.zh-CN.md) · [数据库迁移与备份](https://github.com/yinyanfr/nyarbot/blob/main/docs/database-maintenance.zh-CN.md)
