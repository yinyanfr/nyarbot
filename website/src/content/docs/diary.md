---
title: 07 · 案例：会补发的日记流水线
description: 用一次 GitHub Pages 故障理解结构化输出、持久化阶段、重试和已完成步骤去重。
---

假设小林和群友讨论了一次观星活动，这段讨论成了日记的素材。过了午夜，机器人写完日记，已经推到 GitHub，GitHub Pages（把内容建成可访问网站的托管服务）却迟迟没有确认发布。重试时是从头再写一篇，还是只查网页状态？这类问题适合用**持久化工作流**解决：步骤由程序编排，进度写进数据库，进程重启后依然能读取。

## 先把素材、正文、发布记录分开

```text
writeDiary 工具 → SQLite 中的结构化观察
  → 定时任务选定日期 → 模型生成日记 → 保存正文
  → Telegram 频道发布
  → GitHub 提交 → Pages 就绪检查
  → Telegram 群导读
```

**结构化观察**是带字段的素材记录，可以修改或撤回。例如「群友讨论了观星器材」是一条素材，还不是带叙事的正文。模型用素材写出正文后，应用先保存成稿。再次运行时复用它，避免同一天在频道与网页上出现因重复生成而不同的版本。频道全文、推送 GitHub、检查 Pages、群内导读各有独立状态；「GitHub 接收了提交」不等于「读者能打开网页」。[源码：发布编排](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/diary.ts#L733-L883) · [源码：SQLite 发布状态表](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/services/database.ts#L293-L309)

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

假设进入任务前，正文、频道投递和 GitHub 提交都已经保存。对照下面这两次执行：

| 阶段                    | 第一次查 Pages，服务报错                 | 第二次查 Pages，确认就绪                 |
| ----------------------- | ---------------------------------------- | ---------------------------------------- |
| 正文、频道、GitHub 提交 | 读取已有记录，跳过已完成的动作。         | 同样跳过。                               |
| Pages                   | 暂无就绪记录。                           | 确认就绪，保存状态。                     |
| 群导读                  | 不等网页，发不附页面链接的导读。         | 已发送，跳过；不会因为网页好了再发一次。 |
| 整体结果                | `publish_incomplete`，还有未完成的步骤。 | `published`，本例中的步骤已完成。        |

## 重跑会不会产生两次副作用？

**副作用**是操作在程序外留下的改变，比如群里多了一条消息。**幂等性（idempotency）**是指同一个动作执行多次，效果与执行一次相同。这里按已确认进度跳过，可避免大多数重跑重复操作，但不保证严格「恰好一次」（exactly once）。

想象 Telegram 已经发出导读，进程在写 SQLite 的「已发」标记前退出。重启后应用看到的是「尚未记录成功」，仍有机会再发。外部服务和本地数据库没有一个共同的提交时刻。类似地，某次版本迁移后可能只知道旧日记已生成，不知道历史投递细节；程序会保守标记，避免把未知状态当成未发再批量重送。

## 动手看

打开 [`diary.test.ts` 的补发测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/diary.test.ts#L209-L247)。先预测两次运行后 `notices`（累计发出导读的次数）各是多少。再找到测试中哪个替代函数保证没有重复推送 GitHub。

<details>
<summary>参考答案</summary>

第一次后是 `1`，第二次后仍是 `1`。第二次只补齐了 `github_pages` 的 `ready` 状态。测试把 `pushDiaryToGithub` 替换成一个只要被调用就立刻报错的函数；测试通过意味着快进过程没有重新推送。它并未模拟外部成功但数据库还没有记录的崩溃窗口。

</details>

下一章：[把整条链路画出来，练习定位故障](../capstone/)。
