---
title: 00 · 一条消息如何变成回复
description: 从 Telegram Update 到模型工具再到 Telegram 投递，一次走完 nyarbot 的被动回复链路。
---

假设有人在群里发「@nyarbot 今天的群活动几点开始？」看起来像一次问答，代码里却有三个独立决定：这条消息是否进入系统、何时运行一轮 AI、最后是否真的发出消息。

- **Update**：Telegram 交给机器人的事件信封，一条新消息和一次编辑都可能是 update。
- **Handler**：接收 update 的应用入口，提取消息、识别触发并把任务交给调度器。
- **Turn（回合）**：一次有起止边界的 AI 处理。一个回合可以包含多次模型调用，也可能不发消息。

```text
Telegram Update
  → app.ts 注册 handler、开始轮询
  → setupHandlers：去重、过滤目标群、提取内容、判断触发
  → groupRuntime：登记事件、控制频率、安排回合
  → handleAiTurn → generateAiTurn：组织上下文、运行模型与工具
  → sendAiMessages：格式化并投递到 Telegram
```

## 从 handler 到回合

handler 不是直接 `await` 一次模型请求。它把要做的事封装成函数，交给 runtime 决定什么时候执行：

```ts title="src/handlers/index.ts（节选）"
dependencies.runtime.schedulePassiveTurn({
  label: `message:${msg.message_id}`,
  execute: (abortSignal) =>
    dependencies.handleAiTurn({
      ctx,
      replyToMessageId: msg.message_id,
      // 省略本轮上下文和参数
```

`execute` 里的 `abortSignal` 来自 runtime；把它沿调用链传下去，调度层才有办法中止已经开始的工作。见[任务入队源码](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers/index.ts#L1898-L1928)和[最终发送路径](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers/index.ts#L1048-L1080)。

## 哪些消息走不到模型？

重复送达会在较早的阶段被忽略；其他群聊也不会进入这条群回复链。即便消息属于目标群，普通聊天也不一定触发被动回复：它可以成为后续上下文，由独立的主动探测流程判断何时参与。

## 动手看

在 [`index.test.ts` 的去重测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers/index.test.ts#L281-L303)里找出被重复送入的 update。预测第二次会不会进入用户解析或 runtime，再运行该文件验证。下一章再看被接受的任务如何等待和运行。
