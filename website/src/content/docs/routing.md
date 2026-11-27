---
title: 06 · Routing、Fallback 与运行边界
description: 用主动探测和模型供应商故障看路由、取消、预算和安全回退。
---

群聊冷场邀请机器人插话，和有人直接 @ 它询问实时事实，值得花同样的时间和模型成本吗？**Routing（路由）**是根据输入选择处理路径的过程，可以由规则、模型或两者共同执行。

## 先决定值不值得运行

被触发时，handler 可用本地信号识别短聊、技术、实时信息等；需要时再走 `classifyMessage()`。分类中「需要搜索」是对后续步骤的约束，和模型供应商选择是不同的问题。[源码：分类模型与结果](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L733-L800)

无人直接触发时，proactive 先检查群状态和冷却，再让 `probeGate()` 薄薄地看一遍候选对话。只有 gate 放行、对话尚未变化，才运行完整发言流程：

```ts title="src/libs/proactive.ts"
if (stopped || signal.aborted || !shouldProceed) {
  // Probe decided to stay silent — skip the full model run entirely.
  return;
}
```

主动回复也可能过时：探测后有新群活动，代码会比较活动版本并丢弃过期决定。一次 `true` 只代表值得试，不保证最终发言。[源码：探测和活动版本](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/proactive.ts#L239-L295)

## 回退要看失败发生在哪一步

**Fallback（回退）**是在首选路径不能继续时改走可接受的替代路径。这里部分 DeepSeek 不可用的首步请求可回退到 Gemini，之后同一轮继续用选定的供应商。如果 DeepSeek 已经发出工具调用，应用不会在续步中切到 Gemini：Gemini 对本模型工具续步的签名有要求，混用历史可能使续步无效。

```ts title="src/libs/ai.ts（回退条件节选）"
if (params.abortSignal?.aborted || !isDeepseekUnavailableError(error)) throw error;
// Gemini 3 requires its own thought signatures for tool continuations.
// Switching after DeepSeek has emitted a tool call would produce invalid history.
if (toolContinuation) throw error;
```

首选调用的超时预算与调用方的取消信号可以组合。前者限制等待时间，后者说明整项工作不再需要，不能把它当成一次普通失败而启动回退。[源码：回退 middleware](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L631-L665)

## 动手看

到 [`ai.test.ts` 的 `fallback uses Gemini only for unavailable initial calls` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L1489-L1544)，分别预测首步不可用、调用方取消、带工具历史的续步失败时，替代模型是否会被调用，再对照断言。
