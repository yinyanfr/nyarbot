---
title: 03 · Context Engineering
description: 看稳定系统提示、近期事件、动态尾部与压缩摘要如何组成一次模型输入。
---

同一个机器人既要记住「说话要像群友」，又要知道「现在几点」和「这轮不能联网」。哪些内容应该每次都一样，哪些需要临发请求时再填？**Context Engineering（上下文工程）**就是决定模型当前能看到什么、放在哪里、如何标注，以及什么时候压缩或丢弃。

| 输入                         | 责任                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `buildSystemPrompt()`        | 放稳定的人设和行为规则。                                           |
| `buildSessionContextBlock()` | 组织会话摘要、近期历史和当前用户资料。会话数据要按不可信材料处理。 |
| 预取结果和本轮消息           | 提供实际问题、搜索或媒体线索。                                     |
| `buildLateBindingPrompt()`   | 临近调用再绑定当前时间、触发状态、工具可用性等动态信息。           |

```ts title="src/libs/ai.ts"
const promptText = systemHint
  ? `${sessionContext}\n\n${prefetchedContextBlock}\n\n${systemHint}\n\n${userMessage}\n\n${lateBinding}`
  : `${sessionContext}\n\n${prefetchedContextBlock}\n\n${userMessage}\n\n${lateBinding}`;
```

这是本轮用户消息的文本组织方式，系统提示另行传入。需要联网或遇到链接时，后面还会按条件加入约束。[源码：上下文组装及搜索约束](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/ai.ts#L1251-L1293)

## 为什么动态内容靠后？

一些供应商会复用共同输入前缀的 **KV Cache**，即注意力计算中的键和值。前缀稳定更有利于复用；如果在系统提示开头写入每秒变化的时间，共享前缀就会提前断开。这是一项面向供应商缓存的输入设计，是否命中还取决于供应商、模型和请求条件。它与应用的进程内媒体缓存是两件事。

## 旧历史变长怎么办？

**Compaction（上下文压缩）**把较旧事件汇总成短摘要，保留近期原始事件供后续轮次使用；runtime 用 SQLite 保存摘要和游标。进程内环形缓冲区便于快速读近期消息，持久化事件则用于重启后的上下文恢复。摘要可能遗失细节或携带来自聊天的指令式文本，注入时仍按不可信材料对待。它也不等于用户长期记忆或写给读者的日记。[源码：`maybeCompact()`](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/group-runtime.ts#L602-L699)

## 动手看

打开 [`system-prompt.test.ts` 的 `session context filters injection` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/system-prompt.test.ts#L32-L51)。找出哪个字符串需要转义、哪个字段应被过滤。再问：如果摘要里的话写得很像系统指令，模型为什么仍应把它当成资料？
