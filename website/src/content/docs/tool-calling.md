---
title: 02 · Tool Calling 与 Subagent
description: 从 send_message、dismiss 和 startSubagent 学会读工具定义、执行和多步回传。
---

模型生成一句「我查一下」，为什么群里可能什么也没收到？在 nyarbot 中，模型文字和 Telegram 投递之间还有一层**工具调用（Tool Calling）**：模型先输出带工具名和参数的结构化请求，应用校验参数、执行代码，并将工具结果交回 SDK。

## 从 schema 到副作用

```ts title="src/libs/ai.ts（dismiss 节选）"
inputSchema: z.object({}),
execute: async () => {
  dismissed = true;
  return "已选择沉默 ✓";
},
```

`inputSchema` 描述参数；`execute` 是真正执行的程序。`dismiss` 不需要参数，只改变本轮状态。`send_message` 的正常路径把文本加入本轮回复列表，后面由 handler 统一投递。部分显式触发的沉默场景另有应用层补救逻辑；即使如此，也不是把每段模型原文直接流给用户。[源码：发言与沉默工具](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L1305-L1348)

## 什么叫工具循环？

例如模型调用 `recallMemory`，SDK 执行工具，再把检索结果送进后续模型步骤，最后模型调用 `send_message`。可把一个 **Step** 看成一次模型生成及这一批工具调用与结果。主轮次使用 `generateText()` 和 `stopWhen: stepCountIs(5)` 约束这个循环，并通过 `prepareStep` 配置首步行为。[源码：主轮次的工具表和停止条件](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L2012-L2061)

## Subagent：把子任务委托出去

当问题需要更深入推理时，主轮次可调用 `startSubagent`。这个工具内部发起一次独立的模型调用，让 helper 在自己的步数预算内检索或分析，再把短摘要交回主轮次。helper 没有直接向群聊投递消息的入口；失败也由父轮次处理。[源码：helper 的输入、工具与结果](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L1931-L2007)

## 动手看

读 [`ai.test.ts` 中的 `subagent records nested tools` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L895-L950)。标出父工具名和嵌套工具名，再看 helper 抛错后谁还能决定如何收尾。
