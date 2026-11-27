---
title: 05 · MCP、联网搜索与多模态
description: 对比图片输入、Tavily 搜索与 B 站 MCP，区分模型工具和宿主连接协议。
---

有人发来视频链接并问「这个讲了什么？」模型看到链接不代表看过内容。nyarbot 将读取动作接到 `readVideo` 工具上，再由应用按平台决定怎么读。

**MCP（Model Context Protocol）**规定宿主如何通过客户端与服务器交换工具请求和结果。这里 nyarbot 是宿主，`src/libs/video.ts` 使用 MCP SDK 的 `Client`，通过 `StdioClientTransport` 与子进程通信。B 站后端是 MCP server，不是那个聊天模型。

```text
聊天模型发出 readVideo 工具调用
  → nyarbot 检查 URL / 权限并选择平台
    ├─ YouTube → Gemini 原生视频理解
    └─ Bilibili → MCP Client → stdio → B 站 MCP server
  ← 工具结果交回对话轮次
```

[源码：连接和子进程 transport](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.ts#L309-L343) · [源码：按平台分派](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.ts#L551-L572)

## 同样是外部信息，有三种走法

| 路径          | 请求发给谁          | 模型得到什么                                           |
| ------------- | ------------------- | ------------------------------------------------------ |
| Telegram 图片 | 支持视觉的模型      | 图像与文本一起进入模型，这是多模态输入。               |
| Tavily 搜索   | 搜索服务的 HTTP API | 搜索结果文本，可预取也可由 `webSearch` 触发。          |
| B 站视频      | MCP server          | 只读字幕或元数据。模型看到的是工具结果，不是视频画面。 |

项目将模型工具名 `readVideo` 和 MCP 工具名 `get_video_transcript` 分开。应用传入分 P，并关闭用简介冒充字幕的后端 fallback：

```ts title="src/libs/video.ts"
const transcriptResult = await callBilibiliTool(
  client,
  "get_video_transcript",
  {
    bvid_or_url: bvid,
    fallback_to_description: false,
    ...(page != null ? { page } : {}),
  },
  abortSignal,
);
```

代码用 schema 检查结果，只有来源确认为字幕且文本非空才采用；否则调用 `get_video_metadata`。此时只能依据真实拿到的信息回答，不能补写画面或对白。[源码：字幕验证和元数据降级](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.ts#L447-L494)

## 动手看

在 [`video.test.ts` 的 `falls back from transcript to metadata` 测试](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.test.ts#L125-L158)里跟踪假客户端收到的调用。先预测调用次序，再看为什么测试结果没有字幕也算成功。延伸阅读：[MCP 架构概览](https://modelcontextprotocol.io/docs/learn/architecture)。
