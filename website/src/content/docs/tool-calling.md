---
title: 02 · Tool Calling 与 Subagent
description: 从 send_message、dismiss 和 startSubagent 学会读工具定义、执行和多步回传。
---

模型生成一句「我查一下」，它就真的去查了吗？没有。语言模型写出「查找」，就像人写了一张便条。要查到东西，必须有人读便条、去查、再把结果拿回来。**工具调用（Tool Calling）**约定了便条的格式：模型返回工具名和参数，应用检查请求后运行真实代码，再把结果交给模型。

## 一张工具请求长什么样？

下面用 JSON（能表示字段和值的文本格式）展示一次教学请求。真实请求的封装会随 SDK 和供应商变化；关键是哪个工具、带什么参数、结果是什么。

```json
{
  "tool": "recallMemory",
  "arguments": { "query": "周末爱好", "mode": "relevant" }
}
```

它省略了 `uid`，工具执行时会采用当前用户。若把 `mode` 写成一个工具没定义的值，参数检查就能发现；若写入另一个用户的合法字符串 ID，形状虽然对了，工具还要检查这轮是否授权。**格式正确、允许执行、执行成功**是三件不同的事。

## 从 schema 到副作用

```ts title="src/libs/ai.ts（dismiss 节选）"
inputSchema: z.object({}),
execute: async () => {
  dismissed = true;
  return "已选择沉默 ✓";
},
```

一项工具通常有三部分：`description` 告诉模型什么时候用；`inputSchema`（参数结构）说明参数有哪些、允许什么类型；`execute` 是应用里真正运行的程序。`dismiss` 不需要参数，只改变本轮状态。`send_message` 的正常路径把文本加入本轮回复列表，后面由 handler 统一投递。源码里这项工具会回报「消息已发送」，此刻只是入列成功，仍不能证明 Telegram 收到了。部分显式触发的沉默场景另有应用层补救逻辑；阅读这里时，先把模型原文、待发回复和 Telegram 投递结果分开。[源码：发言与沉默工具](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L1305-L1348)

## 什么叫工具循环？

1. 模型读到小林的问题，提出调用 `recallMemory` 查询「周末爱好」。
2. 应用执行查询，返回一条记录「有空爱拿望远镜看星星」。到这里，模型第一次生成时没有看过答案。
3. AI SDK 在下一次请求里带上前面的工具调用和工具结果。模型现在才能依据这条记录写出「你说过喜欢用望远镜看星星」，并请求 `send_message`。
4. 应用接受待发文本。回合收尾后，Telegram 发送由应用自己的函数负责。

一个 **Step（步骤）**包括一次模型生成及这一批工具执行与结果。一个步骤可以提出多个工具请求，所以限制步数和限制某个工具的调用次数不是一回事。主轮次使用 `generateText()` 和 `stopWhen: stepCountIs(5)` 约束循环，并通过 `prepareStep` 配置首步行为。这个上限也不等于每一轮必然跑五步。[源码：主轮次的工具表和停止条件](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L2012-L2061)

如果模型在同一步既请求回忆又抢着写「你喜欢徒步」，这段回复还没基于检索结果。应用会阻止同一步继续收下这条回复，或者撤掉已经收下的文本，要求后续步骤读完再写。这样不依靠模型自觉遵守先后顺序。

## Subagent：把子任务委托出去

小林接着问：「初学观星，双筒望远镜和天文望远镜各有什么取舍？」主轮次可以自己整理，也可把「比较这两类器材的入门取舍」委托给一个限定职责的 **Subagent（子智能体）**。主轮次调用 `startSubagent` 时，应用会另发起模型调用，子任务在自己的步数预算内使用可用工具，把结果交给主轮次。主轮次决定怎样整合，它们无需像两个人一样在群里来回发言。子任务没有直接向群聊投递的入口，失败也由主轮次处理。多跑一层会增加等待和成本，简单的记忆问答通常不需要委托。[源码：子任务的输入、工具与结果](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L1931-L2007)

## 动手看

打开 [`ai.test.ts` 的工具循环测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L292-L346)。它用「喜欢红茶」代替观星例子。第二次生成前，测试检查模型输入里已经出现了什么？再看[同一步抢答的测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L390-L428)，提前写出的回答最终会不会发出去？

<details>
<summary>参考答案</summary>

第二次已经带入 `recallMemory` 的工具结果，测试检查输入包含「喜欢红茶」。此外，测试共走了三次生成：查记忆、请求发言、结束。另一个测试专门模拟抢答，同一步提前加入的文本不会成为最终回复。进阶：[子智能体的测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L895-L950)展示了子任务的工具和失败怎样交回父轮次。

</details>

下一章：[除了工具结果，一次请求究竟还该带什么？](../context/)
