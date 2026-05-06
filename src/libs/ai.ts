import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, tool, type ModelMessage } from "ai";
import { tavilySearch } from "@tavily/ai-sdk";
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
- needsSearch: true —— 仅当消息涉及最新事件、实时信息、当前事实时才为 true

只输出一个 JSON：{"tier":"simple|complex|tech","needsSearch":true|false}`;

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
    const { text: raw } = await generateText({
      model: flashNoThinkModel,
      system: classificationPrompt,
      prompt: text,
      temperature: 0,
      maxOutputTokens: 100,
    });

    // Extract JSON from response — handles markdown fences and leading/trailing text
    const cleaned = raw.replace(/```(?:json)?\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\{[^{}]*\}/);
    if (jsonMatch) {
      try {
        return classificationSchema.parse(JSON.parse(jsonMatch[0]));
      } catch {
        // fall through
      }
    }
  } catch (err) {
    logger.warn(err, "classification failed, defaulting to simple");
  }
  return { tier: "simple", needsSearch: false };
}

// ---------------------------------------------------------------------------
// Response generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  userContext: User;
  userMessage: string;
  imageUrls: string[];
  recentConversation: string;
  tier: ClassificationResult["tier"];
  needsSearch: boolean;
}

export function generateResponse(opts: GenerateOptions) {
  const { userContext, userMessage, imageUrls, recentConversation, tier, needsSearch } = opts;

  const systemPrompt = buildSystemPrompt(userContext, recentConversation);

  let model: ReturnType<typeof deepseekNoThinking>;

  if (tier === "tech") {
    model = proThinkModel;
  } else if (tier === "complex") {
    model = flashThinkModel;
  } else {
    model = flashNoThinkModel;
  }

  // Build chat message: text + optional images as vision input
  const content: ({ type: "text"; text: string } | { type: "image"; image: string })[] = [
    { type: "text", text: userMessage },
  ];
  for (const url of imageUrls) {
    content.push({ type: "image", image: url });
  }
  const messages: ModelMessage[] = [{ role: "user" as const, content } as ModelMessage];

  const saveMemoryTool = tool({
    description:
      "当你了解到关于某个群友的值得记住的新信息时调用。用于记录该群友的兴趣、偏好、经历、习惯等。",
    inputSchema: z.object({
      uid: z.string().describe("该群友的 Telegram 用户 ID"),
      memory: z.string().describe("关于该群友的一条简洁记忆，用中文，不超过一句话"),
    }),
    execute: async ({ uid, memory }) => {
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
    description: "当群友明确要求你称呼 ta 某个昵称时调用。用于注册或修改该群友的昵称。",
    inputSchema: z.object({
      uid: z.string().describe("该群友的 Telegram 用户 ID"),
      nickname: z.string().describe("群友希望你称呼的昵称，不要超过 10 个字"),
    }),
    execute: async ({ uid, nickname }) => {
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
    description: "当群友要求你忘记某条关于 ta 的记忆，或当你发现某条记忆是错误的时候调用。",
    inputSchema: z.object({
      uid: z.string().describe("该群友的 Telegram 用户 ID"),
      memory: z.string().describe("要删除的记忆内容（与已存储的条目匹配）"),
    }),
    execute: async ({ uid, memory }) => {
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
  const name = userContext.nickname || "群友";

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
// Proactive conversation check: LLM decides whether to jump in
// ---------------------------------------------------------------------------

export async function shouldSpeak(recentHistory: string): Promise<string | null> {
  const { text } = await generateText({
    model: flashNoThinkModel,
    system: "你是 nyarbot，一只傲娇的高中生猫娘 AI。你的语气自然、随意、有猫娘口癖，像群友一样。",
    prompt: `以下是最近的群聊记录。作为一只傲娇猫娘，看看有没有你想傲娇地插话的内容？
如果有，写一句自然简短的猫娘回复（用中文，不超过两行，带猫娘口癖）。如果没什么好说的，或者你刚刚才说过不久，就只输出 SILENT。

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

export async function describeImage(imageUrl: string): Promise<string> {
  const { text } = await generateText({
    model: flashNoThinkModel,
    system: "用中文简短描述这张图片的内容。只输出描述本身，不要加引号或任何前缀。",
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "请用一句话（不超过50字）描述这张图片的内容和氛围。" },
          { type: "image" as const, image: imageUrl },
        ] as ModelMessage["content"],
      } as ModelMessage,
    ],
    maxOutputTokens: 80,
    temperature: 0,
  });
  return text.trim();
}
