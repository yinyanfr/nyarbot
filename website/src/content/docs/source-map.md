---
title: 源码地图与练习命令
description: 按目录找到真实源码，在不接入生产服务的情况下运行章节测试。
---

课程代码、行号和测试基于 [发布提交 `2433dea`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1)。想对照最新版本时，可以从下面这些目录按函数名定位。

| 目录                                                                                                              | 找什么                                     | 读完去哪里                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| [`src/handlers/`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers) | Telegram 入口、内容提取、触发和投递        | [消息链路](../message-to-reply/)                      |
| [`src/libs/`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs)         | Runtime、模型与工具、提示词、MCP、后台日记 | [Agent 与 Harness](../agent-harness/)、[MCP](../mcp/) |
| [`src/services/`](https://github.com/yinyanfr/nyarbot/tree/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services) | SQLite、结构化记忆、向量索引和 GitHub 发布 | [RAG](../memory-rag/)、[日记案例](../diary/)          |

## 跑一个章节练习

在机器人仓库根目录用 Node.js 24.19.0 安装依赖并编译：

```sh
npm ci
npm run build
```

例如只跑工具循环中「先回忆再回答」的测试：

```sh
node --import=./dist/test-setup.js --test \
  --test-name-pattern='real SDK loop feeds recall results' dist/libs/ai.test.js
```

其他章节同样可将源码 `src/.../*.test.ts` 对照为编译后的 `dist/.../*.test.js`，也可以删除 `--test-name-pattern` 运行整个文件。课内测试利用注入的替代实现或隔离数据库，练习不需要填生产凭据。

## 项目参考文档

- [运行架构](https://github.com/yinyanfr/nyarbot/blob/main/docs/architecture.zh-CN.md) · [提示词 XML 结构](https://github.com/yinyanfr/nyarbot/blob/main/docs/prompt-xml-schema.md)
- [开发与测试](https://github.com/yinyanfr/nyarbot/blob/main/docs/development.zh-CN.md) · [环境配置](https://github.com/yinyanfr/nyarbot/blob/main/docs/configuration.zh-CN.md)
- [命令与交互](https://github.com/yinyanfr/nyarbot/blob/main/docs/commands-and-interactions.zh-CN.md) · [数据库迁移与备份](https://github.com/yinyanfr/nyarbot/blob/main/docs/database-maintenance.zh-CN.md)
