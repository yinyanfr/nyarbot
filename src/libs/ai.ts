import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText, streamText, tool, type ModelMessage } from "ai";
import { tavilySearch, tavilyExtract } from "@tavily/ai-sdk";
import { z } from "zod/v4";
import config from "../configs/env.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { updateUserMemory, removeUserMemory, updateUserNickname } from "../services/firestore.js";
import { STICKER_EMOJIS, STICKER_DESCRIPTIONS } from "./stickers.js";
import { logger } from "./logger.js";
import type { User } from "../global.d.ts";

// ---------------------------------------------------------------------------
// DeepSeek providers (OpenAI-compatible, base URL without /v1)
// ---------------------------------------------------------------------------
// DeepSeek 默认启用思考模式 (thinking is ON by default).
// simple 对话需要显式发送 thinking: { type: "disabled" } 以提速降费。
// complex/tech 对话显式开启 thinking: { type: "enabled" }。

/**
 * Inject a DeepSeek-specific `thinking` param into the request body.
 * Returns the modified init or the original if body parsing fails.
 */
function injectThinking(init: RequestInit | undefined, type: "enabled" | "disabled"): RequestInit {
  if (!init || typeof init.body !== "string") return init ?? {};

  try {
    const body = JSON.parse(init.body);
    body.thinking = { type };
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init ?? {};
  }
}

const deepseekNoThinking = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: config.deepseekApiKey,
  name: "deepseek-no-think",
  fetch: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return globalThis.fetch(url, injectThinking(init, "disabled"));
  },
});

const deepseekThink = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: config.deepseekApiKey,
  name: "deepseek-think",
  fetch: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return globalThis.fetch(url, injectThinking(init, "enabled"));
  },
});

// ---------------------------------------------------------------------------
// Model instances
// ---------------------------------------------------------------------------

const flashNoThinkModel = deepseekNoThinking("deepseek-v4-flash");
const flashThinkModel = deepseekThink("deepseek-v4-flash");
const proThinkModel = deepseekThink("deepseek-v4-pro");

// ---------------------------------------------------------------------------
// Message classification (中文 prompt, fast model, thinking disabled)
// ---------------------------------------------------------------------------

const classificationPrompt = `请把下面的用户消息归到以下三个层级之一：

- "simple" —— 闲聊、打招呼、简单问题、随口接话、没啥深度的日常对话
- "complex" —— 需要多步推理、较长的解释、有争议的话题、创意写作、带观点的讨论
- "tech" —— 编程、数学、学术、技术分析、专业领域问题

同时判断是否需要联网搜索：
- needsSearch: true —— 仅当消息涉及最新事件、实时信息、当前事实时才为 true`;

interface ClassificationResult {
  tier: "simple" | "complex" | "tech";
  needsSearch: boolean;
}

const classificationSchema = z.object({
  tier: z.enum(["simple", "complex", "tech"]),
  needsSearch: z.boolean(),
});

export async function classifyMessage(text: string): Promise<ClassificationResult> {
  try {
    const { object } = await generateObject({
      model: flashNoThinkModel,
      system: classificationPrompt,
      prompt: text,
      schema: classificationSchema,
      temperature: 0,
      maxOutputTokens: 100,
    });
    return object;
  } catch (err) {
    logger.warn({ err }, "classification failed, defaulting to simple");
    return { tier: "simple", needsSearch: false };
  }
}

// ---------------------------------------------------------------------------
// Response generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  userContext: User;
  userMessage: string;
  /** Array of image inputs — either `data:` URLs or `https:` URLs. Never include bot-token URLs. */
  imageInputs: string[];
  recentConversation: string;
  recentMembers: { uid: string; name: string }[];
  tier: ClassificationResult["tier"];
  needsSearch: boolean;
  /** UIDs the LLM is allowed to reference in memory tools. */
  allowedUids: Set<string>;
  /** Optional system hint injected before the user message, e.g. "user just woke up". */
  systemHint?: string;
}

export function generateResponse(opts: GenerateOptions) {
  const {
    userContext,
    userMessage,
    imageInputs,
    recentConversation,
    recentMembers,
    tier,
    needsSearch,
    allowedUids,
    systemHint,
  } = opts;

  const systemPrompt = buildSystemPrompt(userContext, recentConversation, recentMembers);

  let model: ReturnType<typeof deepseekNoThinking>;

  if (tier === "tech") {
    model = proThinkModel;
  } else if (tier === "complex") {
    model = flashThinkModel;
  } else {
    model = flashNoThinkModel;
  }

  // Build chat message: text + optional images as vision input.
  // imageInputs should be data URLs (preferred) or safe public URLs — never bot-token URLs.
  const promptText = systemHint ? `${systemHint}\n\n${userMessage}` : userMessage;
  const content: ({ type: "text"; text: string } | { type: "image"; image: string })[] = [
    { type: "text", text: promptText },
  ];
  for (const img of imageInputs) {
    content.push({ type: "image", image: img });
  }
  const messages: ModelMessage[] = [{ role: "user" as const, content } as ModelMessage];

  const saveMemoryTool = tool({
    description:
      "当你了解到关于某个群友的值得记住的新信息时调用。用于记录该群友的兴趣、偏好、经历、习惯等。" +
      "uid 只能从 system prompt 中「最近出现过的群友」列表选取；如果你不知道对方的 uid，就不要调用这个工具。",
    inputSchema: z.object({
      uid: z.string().describe("该群友的 Telegram 用户 ID"),
      memory: z.string().describe("关于该群友的一条简洁记忆，用中文，不超过一句话"),
    }),
    execute: async ({ uid, memory }) => {
      if (!allowedUids.has(uid)) {
        return "未找到该群友喵？uid 对不上";
      }
      try {
        await updateUserMemory(uid, memory);
        return "记忆已保存 ✓";
      } catch (err) {
        logger.error(err, "failed to save memory");
        return "记忆保存失败";
      }
    },
  });

  const setNicknameTool = tool({
    description:
      "当群友明确要求你称呼 ta 某个昵称时调用。用于注册或修改该群友的昵称。" +
      "uid 只能从 system prompt 中「最近出现过的群友」列表选取。",
    inputSchema: z.object({
      uid: z.string().describe("该群友的 Telegram 用户 ID"),
      nickname: z.string().describe("群友希望你称呼的昵称，不要超过 10 个字"),
    }),
    execute: async ({ uid, nickname }) => {
      if (!allowedUids.has(uid)) {
        return "未找到该群友喵？uid 对不上";
      }
      try {
        await updateUserNickname(uid, nickname);
        return "昵称已设置 ✓";
      } catch (err) {
        logger.error(err, "failed to set nickname");
        return "昵称设置失败";
      }
    },
  });

  const deleteMemoryTool = tool({
    description:
      "当群友要求你忘记某条关于 ta 的记忆，或当你发现某条记忆是错误的时候调用。" +
      "uid 只能从 system prompt 中「最近出现过的群友」列表选取。",
    inputSchema: z.object({
      uid: z.string().describe("该群友的 Telegram 用户 ID"),
      memory: z.string().describe("要删除的记忆内容（与已存储的条目匹配）"),
    }),
    execute: async ({ uid, memory }) => {
      if (!allowedUids.has(uid)) {
        return "未找到该群友喵？uid 对不上";
      }
      try {
        await removeUserMemory(uid, memory);
        return "记忆已删除 ✓";
      } catch (err) {
        logger.error(err, "failed to delete memory");
        return "记忆删除失败";
      }
    },
  });

  // Sticker: selected emoji is captured in closure, sent after streaming completes
  let stickerEmoji: string | null = null;

  const sendStickerTool = tool({
    description:
      "当你的回复内容很简短（如 噢、好的、很棒、哈哈），或者对话已经自然结束，可以发送一个贴纸代替或结束对话。" +
      "可用贴纸含义：" +
      STICKER_EMOJIS.map((e) => `${e}(${STICKER_DESCRIPTIONS[e] || ""})`).join(" "),
    inputSchema: z.object({
      emoji: z.enum(STICKER_EMOJIS).describe("要发送的贴纸对应的 emoji"),
    }),
    execute: async ({ emoji }) => {
      stickerEmoji = emoji;
      return "贴纸已发送 ✓";
    },
  });

  const tools = {
    saveMemory: saveMemoryTool,
    setNickname: setNicknameTool,
    deleteMemory: deleteMemoryTool,
    sendSticker: sendStickerTool,
    ...(needsSearch
      ? {
          webSearch: tavilySearch({
            apiKey: config.tavilyApiKey,
            maxResults: 3,
          }),
        }
      : {}),
  };

  const baseParams = {
    model,
    system: systemPrompt,
    messages,
  };

  const result = streamText({ ...baseParams, tools });

  // Resolves with the selected emoji (or null) after all text and tool calls finish
  const stickerPromise = result.text.then(() => stickerEmoji);

  return { textStream: result.textStream, stickerPromise, text: result.text };
}

// ---------------------------------------------------------------------------
// Morning greeting (personalized, fast model)
// ---------------------------------------------------------------------------

export async function generateMorningGreeting(userContext: User): Promise<string> {
  const name = userContext.nickname || "大哥哥";

  const memoriesBlock =
    userContext.memories.length > 0
      ? `关于 ${name} 的记忆：${userContext.memories.join("；")}。`
      : "";

  const { text } = await generateText({
    model: flashNoThinkModel,
    system: `你是 nyarbot，一只傲娇的高中生猫娘 AI。你的语气温暖、带点傲娇但很可爱。`,
    prompt: `${name} 刚刚睡醒上线了。请给 ta 发一句傲娇的问候语，欢迎 ta 回来。${memoriesBlock}
要求：一句话，不要超过两行。语气自然，像朋友之间的日常问候。如果记忆里有关于 ta 今天/近期要做的事，可以顺便提一下。只输出问候语本身，不要加引号或解释。`,
    temperature: 0.8,
    maxOutputTokens: 80,
  });

  return text.trim();
}

// ---------------------------------------------------------------------------
// Love rejection:傲娇好人卡
// ---------------------------------------------------------------------------

export async function generateLoveRejection(userContext: User): Promise<string> {
  const name = userContext.nickname || "大哥哥";

  const memoriesBlock =
    userContext.memories.length > 0
      ? `关于 ${name} 的记忆：${userContext.memories.join("；")}。`
      : `我对 ${name} 还不太了解，几乎没有什么记忆。`;

  const { text } = await generateText({
    model: flashNoThinkModel,
    system:
      "你是 nyarbot，一只傲娇的高中生猫娘 AI。有群友向你告白了，你要傲娇地发好人卡拒绝 ta。语气要傲娇但绝对不能伤人。",
    prompt: `${name} 向你告白了！请傲娇地拒绝 ta。

拒绝策略：
- 如果我对 ta 几乎不了解、记忆很少或没有，就说"我还不了解你呢"，不能随便接受。
- 如果记忆里提到了 ta 的爱好、特点或做过的事，就根据那条记忆编一个俏皮的拒绝理由。
- 无论怎样，最后都要补一句好人卡：告诉 ta 是个好人，一定能找到适合 ta 的女孩子（或适合 ta 的人）。

${memoriesBlock}

要求：3-4句话，自然傲娇，带猫娘口癖（喵、哼、笨蛋等）。只输出拒绝语本身，不要加引号或解释。`,
    temperature: 0.9,
    maxOutputTokens: 150,
  });

  return text.trim();
}

// ---------------------------------------------------------------------------
// Proactive conversation check: LLM decides whether to jump in
// ---------------------------------------------------------------------------

export async function shouldSpeak(recentHistory: string): Promise<string | null> {
  const { text } = await generateText({
    model: flashNoThinkModel,
    system: "你是 nyarbot，一只傲娇的高中生猫娘 AI。你的语气自然、随意、有猫娘口癖，像群友一样。",
    prompt: `以下是最近的群聊记录。作为一只傲娇猫娘，看看有没有你想傲娇地插话的内容？

注意：以「[${config.botUsername}]:」开头的那几行是你自己之前说过的话，不要接自己的话、不要附和自己。
如果刚刚你已经说过了，或者没什么值得插的，就只输出 SILENT。
如果确实有想说的，写一句自然简短的猫娘回复（用中文，不超过两行，带猫娘口癖）。

群聊记录：
---
${recentHistory}
---

你的回复（或 SILENT）：`,
    temperature: 0.85,
    maxOutputTokens: 100,
  });

  const trimmed = text.trim();
  if (!trimmed || trimmed.toUpperCase() === "SILENT") return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Image description (for caching)
// ---------------------------------------------------------------------------

export async function describeImage(imageInput: string): Promise<string> {
  const { text } = await generateText({
    model: flashNoThinkModel,
    system: "用中文简短描述这张图片的内容。只输出描述本身，不要加引号或任何前缀。",
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "请用一句话（不超过50字）描述这张图片的内容和氛围。" },
          { type: "image" as const, image: imageInput },
        ] as ModelMessage["content"],
      } as ModelMessage,
    ],
    maxOutputTokens: 80,
    temperature: 0,
  });
  return text.trim();
}

// ---------------------------------------------------------------------------
// URL content extraction (for shared links)
// ---------------------------------------------------------------------------

export async function fetchUrlContent(url: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: flashNoThinkModel,
      tools: {
        urlExtract: tavilyExtract({
          apiKey: config.tavilyApiKey,
          extractDepth: "basic",
        }),
      },
      system:
        "你是一个网页内容提取工具。必须使用 urlExtract 工具访问给定的链接，提取其核心内容，然后用中文简短总结（不超过80字）。",
      prompt: `提取并总结这个链接的内容：${url}\n\n注意：必须先调用 urlExtract 工具获取内容！如果无法访问或没有有意义的内容，只输出 NULL（大写）。`,
      maxOutputTokens: 150,
      temperature: 0,
    });
    const cleaned = text.trim();
    if (cleaned === "NULL" || cleaned === "null" || !cleaned) return null;
    return cleaned;
  } catch {
    return null;
  }
}
