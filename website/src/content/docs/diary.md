---
title: 07 · 案例：会补发的日记流水线
description: 用一次 GitHub Pages 故障理解结构化输出、持久化阶段、重试和已完成步骤去重。
---

日记已经推到 GitHub，Pages 状态接口却超时了。机器人要不要发群导读？重试时要不要再推一次？这类问题适合用**持久化工作流**解决：步骤和恢复策略由程序定义，每一步成功后记录明确的进度。

```text
writeDiary 工具 → SQLite 中的结构化观察
  → 定时任务选定日期 → 模型生成日记 → 保存正文
  → Telegram 频道发布
  → GitHub 提交 → Pages 就绪检查
  → Telegram 群导读
```

**结构化观察**是带字段的素材记录，可以修改或撤回；它不是最终日记。生成之后将正文保存，重试优先复用已有正文。频道、GitHub、Pages 和群通知使用持久化状态，以便重启后只补未完成的步骤。[源码：发布编排](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/diary.ts#L733-L883) · [源码：SQLite 发布状态表](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services/database.ts#L293-L309)

## Pages 没就绪，群里仍能收到导读

```ts title="src/libs/diary.ts"
const notified =
  noticeSent ||
  (await deliverDiaryNotification(
    yesterdayDate,
    diary,
    pagesReady ? diaryUrl : null,
    dependencies,
    diaryCallbacks,
    abortSignal,
  ));
```

推送成功时先记录提交信息；Pages 就绪另记状态。即使状态查询失败，也能发一条不附页面链接的导读。下一次任务可读取已有提交再查 Pages，已经确认发送的导读不会重发。整体状态仍可返回 `publish_incomplete`，让调度器知道有一步需要重试。

这属于**按已确认进度跳过**，不是分布式的严格 exactly-once。外部服务确认成功与 SQLite 状态提交是两件事，若进程恰好在两者之间退出，可能留下「外部做了，数据库还不知道」的窗口。历史记录也存在未知状态，迁移后会保守标记，避免自动批量补发。

## 动手看

打开 [`diary.test.ts` 的 `a Pages failure does not block the group notice` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/diary.test.ts#L209-L247)。逐项记录第一次和第二次调用后哪些状态变了。解释为什么第一次结果是未完成，但是群导读累计只发了一次。
