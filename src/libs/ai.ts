import { createOpenAI } from "@ai-sdk/openai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { generateText, tool, type LanguageModel, stepCountIs } from "ai";
import { tavilySearch, tavilyExtract } from "@tavily/ai-sdk";
import { z } from "zod/v4";
import config from "../configs/env.js";
import {
  buildSystemPrompt,
  buildLateBindingPrompt,
  buildProbeSystemPrompt,
} from "./system-prompt.js";
import { updateUserMemory, removeUserMemory, updateUserNickname } from "../services/firestore.js";
import { STICKER_EMOJIS, STICKER_DESCRIPTIONS } from "./stickers.js";
import { logger } from "./logger.js";
import type { User } from "../global.d.js";

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
    if (type === "enabled" && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === "assistant" && !("reasoning_content" in msg)) {
          msg.reasoning_content = "";
        }
      }
    }
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
// Gemini provider via Cloudflare AI Gateway (vision only — DeepSeek has no vision)
// ---------------------------------------------------------------------------

const aigateway = createAiGateway({
  accountId: "5b2af39cf1c595a34ffa9057bbf17f0b",
  gateway: "gem",
  apiKey: config.cfAigToken,
});

const unified = createUnified();
const geminiFlashModel = aigateway(unified("google-ai-studio/gemini-3-flash-preview"));

// ---------------------------------------------------------------------------
// Model instances
// ---------------------------------------------------------------------------

const flashNoThinkModel = deepseekNoThinking.chat("deepseek-v4-flash");
const flashThinkModel = deepseekThink.chat("deepseek-v4-flash");
const proThinkModel = deepseekThink.chat("deepseek-v4-pro");

// ---------------------------------------------------------------------------
// Message classification (中文 prompt, fast model, thinking disabled)
// ---------------------------------------------------------------------------

const classificationPrompt = `请把下面的用户消息归到以下三个层级之一：

- "simple" —— 闲聊、打招呼、简单问题、随口接话、没啥深度的日常对话
- "complex" —— 需要多步推理、较长的解释、有争议的话题、创意写作、带观点的讨论
- "tech" —— 编程、数学、学术、技术分析、专业领域问题

同时判断是否需要联网搜索：
- needsSearch: true —— 仅当消息涉及最新事件、实时信息、当前事实时才为 true

请严格以JSON格式回复，不要加任何其他内容：
{"tier":"simple/complex/tech","needsSearch":true/false}`;

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
    const parsed = classificationSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger.warn({ raw }, "classification JSON parse failed, defaulting to simple");
    return { tier: "simple", needsSearch: false };
  } catch (err) {
    logger.warn({ err }, "classification failed, defaulting to simple");
    return { tier: "simple", needsSearch: false };
  }
}

// ---------------------------------------------------------------------------
// Max tokens per tier
// ---------------------------------------------------------------------------

const MAX_TOKENS_BY_TIER: Record<ClassificationResult["tier"], number | undefined> = {
  simple: 200,
  complex: 500,
  tech: undefined, // no hard limit for technical answers
};

// ---------------------------------------------------------------------------
// AiTurnResult — what generateAiTurn returns
// ---------------------------------------------------------------------------

export type AiTurnResult =
  | { action: "send"; messages: string[]; stickerEmoji: string | null }
  | { action: "dismiss"; rawText?: string };

// ---------------------------------------------------------------------------
// Response generation (tool-call architecture)
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  userContext: User;
  userMessage: string;
  recentConversation: string;
  recentMembers: { uid: string; name: string }[];
  tier: ClassificationResult["tier"];
  needsSearch: boolean;
  /** UIDs the LLM is allowed to reference in memory tools. */
  allowedUids: Set<string>;
  /** Optional system hint injected before the user message, e.g. "user just woke up". */
  systemHint?: string | null;
  /** Whether the bot was mentioned or replied-to (for late-binding prompt). */
  wasMentioned?: boolean;
  wasRepliedTo?: boolean;
  /** Recent bot messages for human-likeness feedback (last N send_message texts). */
  recentBotMessages?: string[];
}

export async function generateAiTurn(opts: GenerateOptions): Promise<AiTurnResult> {
  const {
    userContext,
    userMessage,
    recentConversation,
    recentMembers,
    tier,
    needsSearch,
    allowedUids,
    systemHint,
    wasMentioned,
    wasRepliedTo,
    recentBotMessages,
  } = opts;

  const systemPrompt = buildSystemPrompt(userContext, recentConversation, recentMembers);

  let model: LanguageModel;

  if (tier === "tech") {
    model = proThinkModel;
  } else if (tier === "complex") {
    model = flashThinkModel;
  } else {
    model = flashNoThinkModel;
  }

  const maxTokens = MAX_TOKENS_BY_TIER[tier];

  // Build the late-binding prompt that goes at the end of the user message
  const lateBinding = buildLateBindingPrompt({
    wasMentioned: wasMentioned ?? false,
    wasRepliedTo: wasRepliedTo ?? false,
    recentBotMessages: recentBotMessages ?? [],
  });

  const promptText = systemHint
    ? `${systemHint}\n\n${userMessage}\n\n${lateBinding}`
    : `${userMessage}\n\n${lateBinding}`;

  // When search is needed, inject a mandatory instruction so the model
  // doesn't skip the webSearch tool call.
  const finalPromptText = needsSearch
    ? `${promptText}\n\n<强制指令：这条消息涉及需要最新/实时信息的内容，你必须先调用 webSearch 工具搜索后再回答。不要凭记忆回答，务必搜索。>`
    : promptText;

  const messages = [{ role: "user" as const, content: finalPromptText }];

  // Mutable state captured by tool closures
  const sentMessages: string[] = [];
  let stickerEmoji: string | null = null;
  let dismissed = false;

  const sendMessageTool = tool({
    description:
      "向群聊发送一条消息。这是你向群里说话的唯一方式——不调用这个工具就是沉默。" +
      "你可以多次调用 send_message 来发送多条短消息（像真人打字一样一条一条发），但大部分时候一条就够了。" +
      "每条消息应该简短自然，一条消息说一个想法。",
    inputSchema: z.object({
      text: z.string().describe("要发送的消息文本。要像真人在群聊里打字一样自然简短。"),
    }),
    execute: async ({ text }) => {
      sentMessages.push(text);
      return "消息已发送 ✓";
    },
  });

  const dismissTool = tool({
    description:
      "选择不回复。只有当你真的完全无话可说、话题与你毫无关系时才选这个。" +
      "大部分时候你应该用 send_message 回复——你是群友，不是旁观者。",
    inputSchema: z.object({}),
    execute: async () => {
      dismissed = true;
      return "已选择沉默 ✓";
    },
  });

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

  const sendStickerTool = tool({
    description:
      "当你的回复内容很简短（如 噢、好的、很棒、哈哈），或者对话已经自然结束，可以发送一个贴纸代替或结束对话。" +
      "不要在 send_message 的文本中只发一个 emoji——想发贴纸就用 sendSticker。" +
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

  const generateParams: Parameters<typeof generateText>[0] = {
    model,
    system: systemPrompt,
    messages,
    tools: {
      send_message: sendMessageTool,
      dismiss: dismissTool,
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
    },
    stopWhen: stepCountIs(5),
  };
  if (maxTokens != null) {
    generateParams.maxOutputTokens = maxTokens;
  }

  const result = await generateText(generateParams);

  // Log tool call summary for diagnostics
  const toolCallNames = result.steps.flatMap((s) => s.toolCalls.map((tc) => tc.toolName));
  if (toolCallNames.length > 0) {
    logger.info({ toolCallNames, tier, needsSearch }, "generateAiTurn: tool calls made");
  }
  if (needsSearch && !toolCallNames.includes("webSearch")) {
    logger.warn(
      { tier, needsSearch, toolCallNames },
      "generateAiTurn: search was needed but webSearch was not called",
    );
  }

  // Determine the outcome
  const rawText = result.text?.trim();
  const rawTextProp = rawText || undefined;

  // If the model called dismiss but also produced output (e.g. sticker),
  // prefer the output over silence.
  if (dismissed && sentMessages.length === 0 && !stickerEmoji) {
    return rawTextProp
      ? { action: "dismiss" as const, rawText: rawTextProp }
      : { action: "dismiss" as const };
  }

  if (sentMessages.length > 0) {
    return {
      action: "send" as const,
      messages: sentMessages,
      stickerEmoji,
    };
  }

  // Sticker-only: model called sendSticker but not send_message
  if (stickerEmoji) {
    return { action: "send" as const, messages: [], stickerEmoji };
  }

  // Edge case: no send_message and no dismiss — the model just output text
  // (inner monologue). Treat as dismiss, but pass rawText as fallback.
  if (!rawText) {
    return { action: "dismiss" as const };
  }

  logger.info(
    { textContent: rawText.slice(0, 100) },
    "AI generated text without tool call, dismissing",
  );
  return { action: "dismiss" as const, rawText };
}

// ---------------------------------------------------------------------------
// Probe gate (proactive message filtering)
// ---------------------------------------------------------------------------

export interface ProbeGateOptions {
  recentConversation: string;
  recentMembers: { uid: string; name: string }[];
}

/**
 * Cheap model check to determine whether the bot should speak proactively.
 * Returns true if the bot should proceed with the full model, false if it
 * should stay silent.
 */
export async function probeGate(opts: ProbeGateOptions): Promise<boolean> {
  const { recentConversation, recentMembers } = opts;

  const systemPrompt = buildProbeSystemPrompt(recentConversation, recentMembers);

  // Lightweight version of the late-binding prompt for probe context
  const lateBinding =
    "你没有被直接提及。你只是在浏览群聊，决定是否有值得说的话。" +
    "大部分时候你应该选择 dismiss。只有当你真的有独特且有趣的东西可补充时才调用 send_message。";

  let probedDismiss = false;

  const probeDismissTool = tool({
    description: "选择不回复。当你没什么值得说的时就选这个。犹豫时选 dismiss。",
    inputSchema: z.object({}),
    execute: async () => {
      probedDismiss = true;
      return "已选择沉默 ✓";
    },
  });

  const probeSendMessageTool = tool({
    description: "决定回复。仅当你确实有独特且有价值的东西要说时才选这个。",
    inputSchema: z.object({
      text: z.string().describe("你打算说的话的草稿，供参考"),
    }),
    execute: async () => {
      return "探测通过，将使用完整模型生成回复";
    },
  });

  const probeTools = {
    send_message: probeSendMessageTool,
    dismiss: probeDismissTool,
  };

  const messages = [
    {
      role: "user" as const,
      content: `${lateBinding}\n\n请浏览以下群聊记录，决定是否有值得回复的内容。`,
    },
  ];

  try {
    await generateText({
      model: flashNoThinkModel,
      system: systemPrompt,
      messages,
      tools: probeTools,
      stopWhen: stepCountIs(1),
      maxOutputTokens: 60,
      temperature: 0.85,
    });

    // If the probe dismissed, stay silent
    return !probedDismiss;
  } catch (err) {
    logger.warn({ err }, "probe gate failed, defaulting to silent");
    return false;
  }
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
    system: `你是 nyarbot，一只傲娇的高中生猫娘 AI。你的语气温暖、带点傲娇但很可爱。像朋友之间的日常问候，不是客服打招呼。`,
    prompt: `${name} 刚刚睡醒上线了。请给 ta 发一句傲娇的问候语，欢迎 ta 回来。${memoriesBlock}
要求：一句话，不要超过两行。语气自然，像朋友在群聊里随口打招呼，绝对不要像客服。如果记忆里有关于 ta 今天/近期要做的事，可以顺便提一下。只输出问候语本身，不要加引号或解释。`,
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
      "你是 nyarbot，一只傲娇的高中生猫娘 AI。有群友向你告白了，你要傲娇地发好人卡拒绝 ta。语气要傲娇但绝对不能伤人。像聊天，不是写作文。",
    prompt: `${name} 向你告白了！请傲娇地拒绝 ta。

拒绝策略：
- 如果我对 ta 几乎不了解、记忆很少或没有，就说"我还不了解你呢"，不能随便接受。
- 如果记忆里提到了 ta 的爱好、特点或做过的事，就根据那条记忆编一个俏皮的拒绝理由。
- 无论怎样，最后都要补一句好人卡：告诉 ta 是个好人，一定能找到适合 ta 的女孩子（或适合 ta 的人）。

${memoriesBlock}

要求：3-4句话，自然傲娇，带猫娘口癖（喵、哼、笨蛋等）。像聊天一样说，不要写成长篇大论。只输出拒绝语本身，不要加引号或解释。`,
    temperature: 0.9,
    maxOutputTokens: 150,
  });

  return text.trim();
}

// ---------------------------------------------------------------------------
// Image description (for caching)
// ---------------------------------------------------------------------------

export async function describeImage(imageInput: string, caption?: string): Promise<string> {
  const captionNote = caption
    ? `\n4. 用户给图片附加了说明文字：「${caption}」，请结合说明来理解图片。`
    : "";
  const { text } = await generateText({
    model: geminiFlashModel,
    system: `请用中文详细描述这张图片，要求：
1. 详细描述图片的内容、细节和氛围，描述要充分具体
2. 如果图片中包含文字，把所有文字完整提取出来
3. 如果图片是一道题目，尝试解题并给出解答过程${captionNote}
只输出描述本身，不要加引号或任何前缀。`,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "请详细描述这张图片。" },
          { type: "image" as const, image: imageInput },
        ],
      },
    ],
    maxOutputTokens: 8000,
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
