---
title: 00 · 一条消息如何变成回复
description: 从 Telegram Update 到模型工具再到 Telegram 投递，一次走完 nyarbot 的被动回复链路。
---

上一章把应用和模型分开了。现在小林在 Telegram 群里发「@nyarbot 我以前说过周末喜欢做什么？」我们先不管答案是什么，只追踪消息的去向。看起来像一次问答，代码里却有三个独立决定：这条消息是否进入系统、何时运行一轮 AI、最后是否真的发出消息。

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

## 第一步：收到一封事件信封

Telegram 用 Bot API 提供机器人能读取的事件。nyarbot 用 **轮询**接收：程序发请求等新事件，拿到后继续读取下一批。`app.ts` 是启动入口，grammY 是项目拿来收事件和调用 Telegram API 的 TypeScript 库；它把收到的更新转交给注册好的处理函数。

想象事件信封上分别写着「哪个群」「哪个人」「哪条消息」，正文是小林的问题。`@nyarbot` 属于触发信号，作用类似点名。`message_id` 标识聊天中的消息；不要拿它当用户编号。程序还可能在之后收到一个有关同一条消息的编辑事件，所以「更新」不等于「新消息」。

## 第二步：登记消息，判断要不要排队

登记一条消息和启动 AI 是两件事。例如小林发「刚换完镜头」没有直接叫机器人，程序可以先保存这条相关聊天，供以后组装上下文。后来有人 @ 机器人追问「他刚才说换了什么」，被触发的回合才需要模型。过滤、去重和是否允许回复，也不需要先问模型。

触发成立后，handler 不直接等待模型请求。它把要做的事封装成函数，交给 runtime（运行时调度器）决定什么时候执行：

```ts title="src/handlers/index.ts（节选）"
dependencies.runtime.schedulePassiveTurn({
  label: `message:${msg.message_id}`,
  execute: (abortSignal) =>
    dependencies.handleAiTurn({
      ctx,
      replyToMessageId: msg.message_id,
      // 省略本轮上下文和参数
      abortSignal,
    }),
});
```

`execute` 里的 `abortSignal` 来自 runtime；把它沿调用链传下去，调度层才有办法中止已经开始的工作。见[任务入队源码](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers/index.ts#L1898-L1928)和[最终发送路径](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers/index.ts#L1048-L1080)。

## 第三步：模型决定做什么，程序负责投递

小林明确问自己的过往，程序会把这轮识别为需要先回忆，模型后续才能根据查到的内容组织回答。一轮里的调用可能不止一次：传入问题得到查资料的请求，传回资料再让模型写回复。处理完毕后，`sendAiMessages` 才把待发文本转换为 Telegram 支持的格式并投递。把模型返回的内容误当已经发过消息，会让排查投递故障变得很困难。

| 场景                             | 最先去哪里找原因                                                     |
| -------------------------------- | -------------------------------------------------------------------- |
| 机器人收到已判为重复的更新       | handler 的去重判断；不会重复登记到 runtime。                         |
| 普通群聊记录了，但机器人没立刻回 | handler 的触发判断；普通聊天还可能由独立的主动探测判断是否值得参与。 |
| 模型出了结果但群里没有消息       | 看本轮是否有可投递的回复，再看 Telegram 发送结果。                   |

## 动手看

打开 [`index.test.ts` 的去重测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/handlers/index.test.ts#L281-L303)。测试用 `fixture({ duplicate: true })` 模拟已经被判为重复的更新。先预测 `ingested.length` 的值：它记录被交给 runtime 登记的次数。还能不能断言 handler 完全没做任何事？

<details>
<summary>参考答案</summary>

`ingested.length` 是 `0`，所以没有重复登记；测试里 `activities()` 和 `releases()` 各是 `1`，说明活动登记和释放照常发生。这个测试只证明已判为重复时的分支行为，不证明底层怎样识别重复。想亲手验证，可按[练习命令](../source-map/)运行 `dist/handlers/index.test.js`。

</details>

下一章：[两条消息抢着让机器人回话时，谁管顺序？](../agent-harness/)
