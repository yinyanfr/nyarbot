---
title: 01 · Agent、Workflow 与 Harness
description: 区分模型选择下一步和应用掌控执行边界，用 nyarbot 的单群调度理解 Harness。
---

群友连着发来两次 @，模型还没回第一条。谁决定先处理哪一条？再问一个问题：轮到模型后，谁决定先查记忆还是直接说话？这两个问题分别落在程序调度和模型决策两层。

| 术语                      | 在本项目中怎么理解                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent（智能体）**       | 对话回合可以由模型根据当前输入选择下一步，例如调用搜索、读取记忆、发言、沉默。                                                        |
| **Workflow（工作流）**    | 程序预先编排步骤；步骤中也能使用模型。日记从读取素材、生成到分目的地发布，是一个例子。                                                |
| **Harness（运行支撑层）** | 本课程用它指包围模型的应用代码：事件入口、上下文组装、工具权限、调度、终止和投递。这是一个架构视角，仓库中没有专门叫 `Harness` 的类。 |

## 调度是程序做的

```ts title="src/libs/group-runtime.ts"
schedulePassiveTurn(turn: ScheduledTurn): void {
  if (this.shutdown.signal.aborted) return;
  this.pendingTurn = turn;
  if (this.state.running) {
    this.state.dirty = true;
    return;
  }
  this.scheduleDebounce();
}
```

`pendingTurn` 保留最新待处理回合。若已有回合在跑，`dirty` 标记之后还得处理新输入；若空闲，`scheduleDebounce()` 先等一小段安静时间，并保留最大等待约束。这些操作在模型收到请求之前完成。[源码：被动调度](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/group-runtime.ts#L501-L510)

主动回合也先经过 `canRunProactive()`，再占用同一个 `running` 状态，最后在 `finally` 中释放。[源码：主动调度](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/group-runtime.ts#L580-L599) 这个边界决定两个回合会不会抢着向同一个群发言。

## 模型做的决定也有边界

进入 `generateAiTurn()` 以后，模型可在给定工具里选择行为；调用预算、可见用户范围、是否接受工具结果都还由宿主执行。可以把它理解为**程序规定比赛规则，模型在规则内决定下一步**。与之对照，`/roll` 的骰子结果由程序直接生成；随后的后台 AI 反应不参与掷骰结果。

## 动手看

阅读 [`group-runtime.test.ts` 的 `marks dirty` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/group-runtime.test.ts#L462-L509)。画出「第一个回合开始 → 第二条触发到达 → 第一个回合结束 → 重新防抖」四个节点，然后解释为什么第二条没有立即并发执行。

延伸阅读：[Building effective agents](https://www.anthropic.com/research/building-effective-agents) 对 Workflow 与 Agent 的区分。
