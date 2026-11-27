---
title: 05 · MCP、联网搜索与多模态
description: 对比图片输入、Tavily 搜索与 B 站 MCP，区分模型工具和宿主连接协议。
---

小林贴来一个视频链接：「这个视频怎么教人对焦？」如果模型只收到网址，最多知道那是一串指向外部资源的字符；它不会因此看到画面、听到声音、读到字幕。上一章的资料存在 SQLite，这一章的资料来自外部。应用要先选择取得资料的办法，再让模型根据**真实取得的材料**回答。

## 什么是 MCP？为什么有两套工具名称？

**MCP（Model Context Protocol，模型上下文协议）**是一套让应用与外部能力提供方按共同格式通信的约定。它规定了怎样连接、描述能力、请求工具和接收结果。可以把协议想成两套程序约好的单据格式；它不替应用判断什么该查，也不让模型自动获得外部访问权限。

- **宿主**是承载整个 AI 功能的应用：这里是 nyarbot，它决定用不用一项外部能力。
- **客户端**是宿主用来发请求的那部分代码：`src/libs/video.ts` 使用 MCP SDK 的 `Client`。
- **服务器**提供外部能力：这里是 B 站后端。服务器可以是同机的另一个进程，不一定是一台远程主机。
- **传输方式**承载这些请求和结果。这里用 `StdioClientTransport`，通过子进程的标准输入、标准输出传递消息。

主模型看到的工具叫 `readVideo`；B 站后端提供的工具叫 `get_video_transcript` 等。应用拿到第一种请求后，选择是否发第二种。一个是**模型和应用之间的工具调用**，另一个是**应用和外部程序之间的 MCP 调用**。有工具调用不代表用了 MCP。

```text
聊天模型发出 readVideo 工具调用
  → nyarbot 检查 URL / 权限并选择平台
    ├─ YouTube → Gemini 原生视频理解
    └─ Bilibili → MCP Client → stdio → B 站 MCP server
  ← 工具结果交回对话轮次
```

[源码：连接和子进程 transport](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.ts#L309-L343) · [源码：按平台分派](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.ts#L551-L572)

## 同样是外部信息，有三种走法

**多模态（multimodal）**是指模型可以处理文本以外的数据形态，比如图片或视频。把字幕文本传给模型和把图像数据传给模型，能支撑的结论不同：

| 路径          | 请求发给谁          | 模型得到什么                                           |
| ------------- | ------------------- | ------------------------------------------------------ |
| Telegram 图片 | 支持视觉的模型      | 图像与文本一起进入模型，这是多模态输入。               |
| Tavily 搜索   | 搜索服务的 HTTP API | 搜索结果文本，可预取也可由 `webSearch` 触发。          |
| B 站视频      | MCP server          | 只读字幕或元数据。模型看到的是工具结果，不是视频画面。 |

YouTube 路径另调用支持相关视频输入的 Gemini，应用再将结果交回主轮次；同一个 `readVideo` 入口背后可以用两套不同实现。Tavily 搜索则直接调用 HTTP 接口，不经过 MCP。区分这些路径，可以回答「模型实际看见了什么」，也能知道报错应该看哪一侧。

## 字幕取不到时，降级到哪里？

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

代码用 schema 检查结果，只有来源确认为字幕且文本非空才采用；否则尝试 `get_video_metadata`。**元数据**是关于资源的描述资料，例如标题、简介，它不是字幕。如果只读到简介「入门对焦」，回复可以说「简介显示这是对焦教程，我没取到字幕」，不能编出视频的具体步骤。标注来源既帮助模型组织答案，也让读者知道答案究竟基于什么。[源码：字幕验证和元数据降级](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.ts#L447-L494)

## 动手看

小林追问「两分半时演示了哪个按钮？」已知字幕没取到，返回结果只有标题和简介。判断模型能不能说出按钮名；然后在 [`video.test.ts`](https://github.com/yinyanfr/nyarbot/blob/2433deab6c72ea1ccc44b39c22887badfd638fa1/src/libs/video.test.ts#L125-L158) 找到假客户端收到的两个工具名。

<details>
<summary>参考答案</summary>

先试 `get_video_transcript`，取不到才调用 `get_video_metadata`。测试验证取得元数据是一次有用的降级，不表示成功解读画面；提供的资料不足以确认按钮名。就算拿到了字幕，也要先看字幕是否真的提到这个按钮。

</details>

下一章：[哪条路径该运行，什么时候该改走另一条？](../routing/) 延伸阅读：[MCP 架构概览](https://modelcontextprotocol.io/docs/learn/architecture)。
