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
import {
  updateUserMemory,
  removeUserMemory,
  updateUserNickname,
  writeDiaryEntry,
  overwriteUserMemories,
} from "../services/firestore.js";
import { getStickerEmojis, getStickerFileId } from "./stickers.js";
import { logger } from "./logger.js";
import { getPersonaLabel } from "./persona.js";
import type { User } from "../global.d.js";

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

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
  baseURL: config.deepseekBaseUrl,
  apiKey: config.deepseekApiKey,
  name: "deepseek-no-think",
  fetch: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return globalThis.fetch(url, injectThinking(init, "disabled"));
  },
});

const deepseekThink = createOpenAI({
  baseURL: config.deepseekBaseUrl,
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
  accountId: config.cfAccountId,
  gateway: config.cfAigGateway,
  apiKey: config.cfAigToken,
});

const unified = createUnified();
const geminiFlashModel = aigateway(unified("google-ai-studio/gemini-3-flash-preview"));

// ---------------------------------------------------------------------------
// Model instances
// ---------------------------------------------------------------------------

const flashNoThinkModel = deepseekNoThinking.chat("deepseek-v4-flash");
export { flashNoThinkModel };
export const flashThinkModel = deepseekThink.chat("deepseek-v4-flash");
export const proThinkModel = deepseekThink.chat("deepseek-v4-pro");

// ---------------------------------------------------------------------------
// Message classification (中文 prompt, fast model, thinking disabled)
// ---------------------------------------------------------------------------

const classificationPrompt = `<classification_system>
  <task>将用户消息分类并判断是否需要联网搜索</task>
  <tiers>
    <tier id="simple">闲聊、打招呼、简单问题、随口接话、日常对话</tier>
    <tier id="complex">需要多步推理、较长解释、有争议话题、创意写作、带观点讨论</tier>
    <tier id="tech">编程、数学、学术、技术分析、专业问题</tier>
  </tiers>
  <search_rule>
    <needsSearch>true 仅当消息涉及最新事件、实时信息、当前事实</needsSearch>
  </search_rule>
  <output_format>{"tier":"simple/complex/tech","needsSearch":true/false}</output_format>
  <constraints>严格输出 JSON，不要输出其他内容</constraints>
</classification_system>`;

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
  | { action: "send"; messages: string[]; stickerFileId: string | null }
  | { action: "dismiss"; rawText?: string };

// ---------------------------------------------------------------------------
// Response generation (tool-call architecture)
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  userContext: User;
  userMessage: string;
  recentConversation: string;
  recentMembers: { uid: string; name: string; username?: string }[];
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
    ? `${promptText}\n\n<mandatory_instruction><reason>消息涉及最新/实时信息</reason><rule>必须先调用 webSearch 再回答</rule><forbidden>不要凭记忆直接回答</forbidden></mandatory_instruction>`
    : promptText;

  const messages = [{ role: "user" as const, content: finalPromptText }];

  // Mutable state captured by tool closures
  const sentMessages: string[] = [];
  let stickerFileId: string | null = null;
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
        const memories = await updateUserMemory(uid, memory);
        if (memories.length > COMPRESS_TRIGGER_COUNT) {
          compressUserMemories(uid, memories).catch((err: unknown) =>
            logger.warn({ err, uid }, "memory compression background task failed"),
          );
        }
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

  const writeDiaryTool = tool({
    description:
      "记录值得记住的对话片段作为日记观察。写简短自然的观察（1-2句中文），像记笔记一样。" +
      "适合记录的内容：有趣的事件、群友的情绪变化、重要的讨论、你自己的想法和感受。" +
      "不要频繁记录——只在有值得记住的事情时才调用。",
    inputSchema: z.object({
      note: z.string().describe("一条简短的观察记录，中文，1-2句话"),
    }),
    execute: async ({ note }) => {
      try {
        await writeDiaryEntry(note);
        return "日记已记录 ✓";
      } catch (err) {
        logger.error(err, "failed to write diary entry");
        return "日记记录失败";
      }
    },
  });

  const sendStickerTool = tool({
    description:
      "当你的回复内容很简短（如 噢、好的、很棒、哈哈），或者对话已经自然结束，可以发送一个贴纸代替或结束对话。" +
      "不要在 send_message 的文本中只发一个 emoji——想发贴纸就用 sendSticker。" +
      `可用贴纸 emoji：${getStickerEmojis().join(" ")}`,
    inputSchema: z.object({
      emoji: z.string().describe("贴纸对应的 emoji，从可用列表中选取"),
    }),
    execute: async ({ emoji }) => {
      stickerFileId = getStickerFileId(emoji);
      if (stickerFileId) return "贴纸已发送 ✓";
      return "这个 emoji 没有对应贴纸，已取消发送";
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
      writeDiary: writeDiaryTool,
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
  if (dismissed && sentMessages.length === 0 && !stickerFileId) {
    return rawTextProp
      ? { action: "dismiss" as const, rawText: rawTextProp }
      : { action: "dismiss" as const };
  }

  if (sentMessages.length > 0) {
    return {
      action: "send" as const,
      messages: sentMessages,
      stickerFileId,
    };
  }

  // Sticker-only: model called sendSticker but not send_message
  if (stickerFileId) {
    return { action: "send" as const, messages: [], stickerFileId };
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
  recentMembers: { uid: string; name: string; username?: string }[];
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
    "<probe_context><mention_state>not_directly_mentioned</mention_state><task>浏览群聊并判断是否值得回复</task><default>大部分时候选择 dismiss</default><allow>仅当有独特且有趣的补充时调用 send_message</allow></probe_context>";

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
    system: `<morning_greeting_system><persona>${xmlEscape(getPersonaLabel())}</persona><tone>温暖、轻微傲娇、朋友式问候，禁止客服口吻</tone></morning_greeting_system>`,
    prompt: `<morning_greeting_request><user name="${xmlEscape(name)}" /><memory>${xmlEscape(memoriesBlock)}</memory><constraints><line_count>一句话</line_count><max_lines>2</max_lines><style>自然、群聊口吻</style><output>只输出问候语本身</output></constraints></morning_greeting_request>`,
    temperature: 0.8,
    maxOutputTokens: 80,
  });

  return text.trim();
}

// ---------------------------------------------------------------------------
// Love response: memory-based affection scoring
// ---------------------------------------------------------------------------

export async function generateLoveResponse(userContext: User): Promise<string> {
  const name = userContext.nickname || "大哥哥";

  const memoriesBlock =
    userContext.memories.length > 0
      ? `关于 ${name} 的记忆：${userContext.memories.join("；")}。`
      : `我对 ${name} 还不太了解，几乎没有什么记忆。`;

  const { text, finishReason } = await generateText({
    model: flashNoThinkModel,
    system: `<love_affection_system><persona>${xmlEscape(getPersonaLabel())}</persona><task>根据记忆计算好感度并回应告白</task><tone>傲娇、可爱、群聊口吻，不要伤人</tone><output_rule>最终回复必须是普通聊天文本，禁止输出 XML/HTML/Markdown 标签</output_rule></love_affection_system>`,
    prompt: `<love_affection_request><user name="${xmlEscape(name)}" /><memories>${xmlEscape(memoriesBlock)}</memories><scoring><rule>你可以自由制定加减分标准</rule><rule>评分条目必须基于 memories，禁止编造不存在的事件</rule><rule>评分明细最多 10 条，每条使用"描述 +/-分值"格式</rule><rule>如果记忆太少，可以给"了解不足"相关条目并保持低置信</rule><rule>最后必须给出总分</rule></scoring><response_policy><rule>根据总分自由决定态度（嘴硬、观察、暧昧、轻微接受、傲娇拒绝等）</rule><rule>回复要符合猫娘人设、自然口语</rule><rule>回应部分最多 5 句话，不要写长篇剧情</rule></response_policy><output_format><rule>只输出普通纯文本，不要输出任何尖括号标签</rule><rule>格式为：评分明细：换行条目；总分：X；回应：一句到三句话</rule></output_format></love_affection_request>`,
    temperature: 0.9,
    maxOutputTokens: 1000,
  });

  if (finishReason === "length") {
    logger.warn({ uid: userContext.uid }, "generateLoveResponse: output truncated by model");
  }

  return sanitizeLoveResponse(text);
}

function sanitizeLoveResponse(text: string): string {
  return text
    .replace(/<\/?(?:评分明细|总分|回应)>/g, "")
    .replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*[^>]*>/g, "")
    .replace(/&lt;\/?[a-zA-Z_][^&]*&gt;/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Image description (for caching)
// ---------------------------------------------------------------------------

export async function describeImage(
  imageInput: string,
  caption?: string,
  mediaType?: string,
): Promise<string> {
  const captionNote = caption
    ? `\n4. 用户给图片附加了说明文字：「${caption}」，请结合说明来理解图片。`
    : "";
  const mediaNote = mediaType
    ? `\n注意：这是一张${mediaType}的缩略图/封面。请描述你看到的画面内容——这是${mediaType}的视觉预览。`
    : "";
  const { text, finishReason } = await generateText({
    model: geminiFlashModel,
    system: `<image_description_system><language>zh-CN</language><rules><rule>详细描述内容、细节、氛围</rule><rule>完整提取图片内文字${captionNote}${mediaNote}</rule><rule>若是题目，尝试解题并给出过程</rule><rule>只输出描述本身</rule></rules></image_description_system>`,
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
  const result = text.trim();
  if (!result) {
    logger.warn(
      { finishReason, dataUrlPrefix: imageInput.slice(0, 120), mediaType },
      "describeImage: empty response from Gemini",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Memory compression — merge groups of 5 memories into 1 to cap token growth
// ---------------------------------------------------------------------------

const COMPRESS_CHUNK_SIZE = 5;
const COMPRESS_TRIGGER_COUNT = 10;
const compressingUids = new Set<string>();

async function compressMemoriesChunk(chunk: string[]): Promise<string> {
  const { text } = await generateText({
    model: flashNoThinkModel,
    system:
      "<memory_compression_system><task>将同一人的多条记忆压缩为一条</task><rules><rule>保留关键信息</rule><rule>长度接近单条原始记忆</rule></rules></memory_compression_system>",
    messages: [
      {
        role: "user" as const,
        content: `请将以下${chunk.length}条关于同一个人的记忆合并为1条简洁的记忆：\n${chunk.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n只输出合并后的记忆文本，不要加编号或引号。`,
      },
    ],
    maxOutputTokens: 150,
    temperature: 0,
  });
  return text.trim();
}

async function compressUserMemories(uid: string, memories: string[]): Promise<void> {
  if (memories.length <= COMPRESS_TRIGGER_COUNT) return;
  if (compressingUids.has(uid)) return;
  compressingUids.add(uid);
  try {
    logger.info({ uid, count: memories.length }, "compressing memories");

    const chunks: string[][] = [];
    for (let i = 0; i < memories.length; i += COMPRESS_CHUNK_SIZE) {
      const chunk = memories.slice(i, i + COMPRESS_CHUNK_SIZE);
      if (chunk.length > 1) chunks.push(chunk);
    }

    if (chunks.length === 0) return;

    const compressed: string[] = [];
    for (const chunk of chunks) {
      const merged = await compressMemoriesChunk(chunk);
      if (merged) compressed.push(merged);
    }

    // Single leftover memory (not enough for a chunk) — keep as-is
    if (memories.length % COMPRESS_CHUNK_SIZE === 1) {
      compressed.push(memories[memories.length - 1]!);
    }

    await overwriteUserMemories(uid, compressed, memories);
    logger.info({ uid, before: memories.length, after: compressed.length }, "memories compressed");
  } catch (err) {
    logger.warn({ err, uid }, "memory compression failed");
  } finally {
    compressingUids.delete(uid);
  }
}

// ---------------------------------------------------------------------------
// URL content extraction (for shared links)
// ---------------------------------------------------------------------------

const TWITTER_STATUS_REGEX =
  /https?:\/\/(?:twitter\.com|x\.com|mobile\.twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com)\/(\w+)\/status\/(\d+)/i;

/** Download an arbitrary URL as a base64 data URL (max 10 MB). Returns null on failure. */
async function downloadUrlAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    const MAX_BYTES = 10 * 1024 * 1024;
    if (buf.length > MAX_BYTES) return null;
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Describe multiple tweet photos in a single Gemini call.
 * Returns one description per photo (same order), ≤150 Chinese chars each.
 */
async function describeTweetPhotos(
  dataUrls: string[],
  photos: { altText?: string }[],
): Promise<string[]> {
  try {
    const altHints = photos
      .map((p, i) => (p.altText ? `图${i + 1} alt: "${p.altText}"` : ""))
      .filter(Boolean)
      .join("; ");
    const hint = altHints ? ` (已知信息: ${altHints})` : "";

    const content: ({ type: "text"; text: string } | { type: "image"; image: string })[] = [
      {
        type: "text",
        text: `<tweet_photo_description_request><language>zh-CN</language><hint>${xmlEscape(hint)}</hint><constraints><max_length_each>150字</max_length_each><style>简洁准确</style><output>按图片顺序逐行输出，不编号不前缀</output></constraints></tweet_photo_description_request>`,
      },
    ];
    for (const dataUrl of dataUrls) {
      content.push({ type: "image", image: dataUrl });
    }

    const { text } = await generateText({
      model: geminiFlashModel,
      messages: [{ role: "user", content }],
      maxOutputTokens: 200 * dataUrls.length,
      temperature: 0,
    });

    return text
      .split("\n")
      .map((s: string) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface FxTweetResponse {
  code: number;
  tweet?: {
    text?: string;
    author?: { name?: string; screen_name?: string };
    media?: { photos?: { url: string; altText?: string }[] };
    qrt?: {
      text?: string;
      author?: { name?: string; screen_name?: string };
    };
  };
}

async function fetchTwitterContent(
  url: string,
  username: string,
  tweetId: string,
): Promise<string | null> {
  try {
    const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as FxTweetResponse;
    if (data.code !== 200 || !data.tweet) return null;

    const tweet = data.tweet;
    const author = `${tweet.author?.name ?? username} (@${tweet.author?.screen_name ?? username})`;

    let mediaDesc = "";
    const photos = tweet.media?.photos;
    if (photos?.length) {
      const photoSlice = photos.slice(0, 4);
      const dataUrls: string[] = [];
      for (const photo of photoSlice) {
        const dataUrl = await downloadUrlAsDataUrl(photo.url);
        if (dataUrl) dataUrls.push(dataUrl);
      }
      if (dataUrls.length > 0) {
        const descriptions = await describeTweetPhotos(
          dataUrls,
          photoSlice.slice(0, dataUrls.length),
        );
        mediaDesc = ` | 配图: ${descriptions.join("; ")}`;
      } else {
        mediaDesc = ` | [${photos.length}张图]`;
      }
    }

    let qrtDesc = "";
    if (tweet.qrt) {
      const qrt = tweet.qrt;
      const qrtAuthor = qrt.author?.screen_name ?? "";
      qrtDesc = ` | 引用 @${qrtAuthor}: ${qrt.text ?? ""}`;
    }

    return `[Tweet ${url} | ${author}: ${tweet.text ?? ""}${mediaDesc}${qrtDesc}]`;
  } catch {
    return null;
  }
}

async function fetchDirectPageInfo(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/html")) {
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const descMatch =
        html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ??
        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);

      const parts: string[] = [];
      const title = titleMatch?.[1]?.trim();
      const desc = descMatch?.[1]?.trim();
      if (title) parts.push(`标题: ${title}`);
      if (desc) parts.push(desc);

      return parts.length > 0 ? parts.join(" — ") : null;
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchTavilyContent(url: string): Promise<string | null> {
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
        "<url_extract_system><task>使用 urlExtract 抓取给定链接并中文摘要</task><constraints><must_call>urlExtract</must_call><max_length>80字</max_length><failure_output>NULL</failure_output></constraints></url_extract_system>",
      prompt: `<url_extract_request><url>${xmlEscape(url)}</url><must_call_tool>urlExtract</must_call_tool><failure>无法访问或无有效内容时仅输出 NULL</failure></url_extract_request>`,
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

export async function fetchUrlContent(url: string): Promise<string | null> {
  const twitterMatch = url.match(TWITTER_STATUS_REGEX);
  if (twitterMatch) {
    return fetchTwitterContent(url, twitterMatch[1]!, twitterMatch[2]!);
  }

  const directResult = await fetchDirectPageInfo(url);
  if (directResult) return directResult;

  return fetchTavilyContent(url);
}
