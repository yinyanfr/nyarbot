---
title: 06 · Routing、Fallback 与运行边界
description: 用主动探测和模型供应商故障看路由、取消、预算和安全回退。
---

小林发「晚上好」，接着有人 @ 机器人问「今晚的观星天气怎么样？」两条都是文字，却不需要走同一条路径。一个可能根本无需被动回复；另一个即使模型能写得头头是道，也需要新资料。**Routing（路由）**就是决定选哪条处理路径，可以由普通规则、模型判断或两者共同执行。

## 先分清「要不要回」「要不要查」「用哪个模型」

被触发时，handler 可用本地信号识别短聊、技术、实时信息等；需要时再走 `classifyMessage()`。分类中「需要搜索」是对后续步骤的约束，和模型供应商选择是不同的问题。[源码：分类模型与结果](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L733-L800)

你可以依次问三个问题：有什么触发信号？回答需要什么证据？哪条调用路径能在可接受的时间内拿到它？不必为每一个简单判断都请求模型。应用先处理能用规则判断的情况，再把仍需语言理解的问题交给模型。

## 主动插话：先做一个小判断

无人直接触发时，proactive（主动逻辑）先检查群状态和冷却时间，再让 `probeGate()` 做一次 **Probe（探测）**：用较轻的模型根据有限的对话资料判断现在是否值得参与。探测只决定是否继续，不替主回合写最后的回复。如果一百次检查里只有少量适合发言，把所有检查都交给完整回合，会做大量用不上的工作。只有探测放行、对话尚未变化，才运行完整发言流程：

```ts title="src/libs/proactive.ts"
if (stopped || signal.aborted || !shouldProceed) {
  // Probe decided to stay silent — skip the full model run entirely.
  return;
}
```

主动回复也可能过时：它原本打算接着聊观星，等待探测时群友已经转去讨论晚饭。代码会比较活动版本（用来判断群状态是否变化的标记）并丢弃过期决定。一次 `true` 只代表值得试，不保证最终发言。[源码：探测和活动版本](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/proactive.ts#L239-L295)

## 回退要看失败发生在哪一步

**Fallback（回退）**是在首选路径不能继续时改走可接受的替代路径。这里部分 DeepSeek 不可用的首步请求可回退到 Gemini，之后同一轮继续用选定的供应商。如果 DeepSeek 已经发出工具调用，应用不会在续步中切到 Gemini：Gemini 对本模型工具续步的签名有要求，混用历史可能使续步无效。

```ts title="src/libs/ai.ts（回退条件节选）"
if (params.abortSignal?.aborted || !isDeepseekUnavailableError(error)) throw error;
// Gemini 3 requires its own thought signatures for tool continuations.
// Switching after DeepSeek has emitted a tool call would produce invalid history.
if (toolContinuation) throw error;
```

首选调用的超时预算与调用方的取消信号可以组合。前者限制等待时间，后者说明整项工作不再需要，不能把它当成一次普通失败而启动回退。[源码：回退 middleware](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L631-L665)

| 遇到的情况                   | 这类机制解决什么                                                               |
| ---------------------------- | ------------------------------------------------------------------------------ |
| 同一个外部服务临时故障       | **重试（retry）**：满足条件时再做同一个动作，通常限制次数。                    |
| 首选服务不可用，还有兼容路径 | **回退（fallback）**：改走替代方案，例如首步改用另一个供应商。                 |
| 资料不全，仍可给有限答案     | **降级**：采用较少的证据或较小的功能。例如仍做关键词检索，但可能漏掉同义表达。 |
| 整项任务被取消               | **停止**：没有继续做的理由，不能假定需要再试或回退。                           |

## 动手看

分别预测首步不可用、调用方取消、带工具历史的续步失败时，是否会切换到 Gemini。再想一下：主动探测返回「值得继续」，但这时群里已经来了新消息，该把之前的决定直接交给主模型吗？

<details>
<summary>参考答案</summary>

第一种符合回退条件时可以切换；已取消则结束，带工具历史的续步也不切换供应商。探测对应的是旧对话，群活动变化后旧决定会被丢弃。对照[首步回退与取消测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L1489-L1544)和上面的主动探测源码。

</details>

下一章：[任务没取消，但只做完一半，如何下次接着做？](../diary/)
