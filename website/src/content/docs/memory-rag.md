---
title: 04 · Memory、RAG 与混合检索
description: 沿着一条记忆查询学习先检索再生成、Embedding、余弦相似度、RRF 与降级。
---

设想机器人记过一件事：「群友喜欢用望远镜看星空。」今天这位群友问：「我之前说过喜欢哪种天文活动？」文字不同，答案却在那条记录里。

**RAG（Retrieval-Augmented Generation，检索增强生成）**把相关资料取回来，再让模型依据资料生成。这里的资料是 SQLite 中结构化的用户记忆；群聊原文、日记、运行摘要不进这套向量索引。长期记忆也不要求每一轮都读：

| 例子                             | 路径                                                 |
| -------------------------------- | ---------------------------------------------------- |
| 「我以前说过喜欢哪种天文活动？」 | 识别为明确的自我回忆时，第一步强制查询本人的记忆。   |
| 「那就按上次那个安排吧」         | 识别为隐含回忆、当前对话不足且对象明确时，按需查询。 |
| 「晚上好」                       | 普通闲聊不自动预取长期记忆。                         |

```ts title="src/libs/ai.ts（prepareStep 节选）"
if (stepNumber === 0 && recallIntent === "explicit") {
  return { toolChoice: { type: "tool", toolName: "recallMemory" } };
}
```

如果同一步同时查记忆和起草发言，应用会丢弃这一批提前写好的回复，让模型下一步先读结果再答。找不到记忆时应说明，而不是编造。[源码：首步选择](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L2036-L2042) · [源码：工具结果与读取预算](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L1350-L1416)

## 两条排序路线怎么合并？

1. **先限定候选。** 查询按用户、有效状态、过期时间和可选时间范围过滤。先把范围限定再排名，其他用户的数据不会作为结果候选。
2. **关键词检索优先保字面信息。** 适合昵称、人名、编号等具体短词。
3. **Embedding（向量表示）补充语义信息。** Ollama 上的 `bge-m3` 将输入映射为向量。对同一模型的归一化向量做精确余弦相似度计算，比较意思是否相近。本项目使用 SQLite 存向量，不需要独立向量数据库。
4. **RRF（Reciprocal Rank Fusion，倒数排名融合）合并名次。** 每张榜的第 1 名得 `1/61`，第 2 名得 `1/62`；同一条记录在两张榜上的分数相加。这样不必直接比较关键词分数和余弦分数。

```ts title="src/services/user-memory.ts"
for (const list of [lexical, semanticRows]) {
  list.forEach((row, i) => {
    const score = (fused.get(row.id)?.score ?? 0) + 1 / (60 + i + 1);
    fused.set(row.id, { row, score });
  });
}
```

如果向量查询超过 750 ms 的预算、失败或没有返回合格候选，关键词路径仍可工作。`recent` 模式另走时间排序，早安问候取最近三条，不需要找语义相近的记录。[源码：过滤、预算和排序](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services/user-memory.ts#L181-L297) · [源码：索引怎样写入](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services/memory-embeddings.ts#L55-L105)

## 动手看

运行 [`memory-embeddings.test.ts` 的 `hybrid finds paraphrases` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services/memory-embeddings.test.ts#L36-L108)。它用假向量验证同义表达、字面命中和用户范围。再读 [`ai.test.ts` 的真实 SDK 循环测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.test.ts#L292-L370)，确认记忆结果出现在发言之前。
