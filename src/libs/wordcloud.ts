import { fileURLToPath } from "node:url";
import { InputFile } from "grammy";
import { GlobalFonts, createCanvas, type CanvasRenderingContext2D } from "@napi-rs/canvas";
import nodejieba from "nodejieba";
import {
  hasWordcloudRunForDate,
  listStoredMessagesForDate,
  listTopActiveUsersForDate,
  markWordcloudRunForDate,
  pruneStoredMessages,
  type ActiveUserStat,
} from "../services/local-wordcloud-store.js";
import { logger } from "./logger.js";
import { now, todayDateStr, yesterdayDateStr } from "./time.js";

const CANVAS_SIZE = 1024;
const MAX_WORDS = 80;
const MAX_LAYOUT_ATTEMPTS = 900;
const MIN_FONT_SIZE = 18;
const MAX_FONT_SIZE = 144;
const WORD_PADDING = 12;
const WORD_SIZE_EXPONENT = 1.35;
const COLORS = [
  "#ff6b9d",
  "#ff8fab",
  "#ffb3c7",
  "#8e7dff",
  "#6ec5ff",
  "#6fd3c1",
  "#f7a541",
  "#ff6680",
] as const;
const BACKGROUND_TOP = "#fff9fc";
const BACKGROUND_BOTTOM = "#f3f7ff";
const BUNDLED_CJK_FONT_ALIAS = "NyarbotWordcloudCJK";
const BUNDLED_CJK_FONT_PATH = fileURLToPath(
  new URL("../../assets/fonts/SourceHanSans-VF.ttf", import.meta.url),
);
const DEFAULT_FONT_FAMILY =
  '"NyarbotWordcloudCJK", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';
const STOP_WORDS = new Set([
  "的",
  "了",
  "是",
  "我",
  "你",
  "他",
  "她",
  "它",
  "这",
  "那",
  "也",
  "就",
  "都",
  "很",
  "还",
  "啊",
  "呀",
  "吗",
  "嘛",
  "吧",
  "呢",
  "哦",
  "喵",
  "欸",
  "诶",
  "嗯",
  "呜",
  "哈",
  "哈哈",
  "不是",
  "就是",
  "一个",
  "这个",
  "那个",
  "我们",
  "你们",
  "他们",
  "然后",
  "因为",
  "所以",
  "但是",
  "如果",
  "已经",
  "还是",
  "一下",
  "一点",
  "一下子",
  "什么",
  "怎么",
  "为什么",
  "真的",
  "感觉",
  "可以",
  "不会",
  "没有",
  "一个",
  "自己",
  "今天",
  "昨天",
  "现在",
  "知道",
  "东西",
  "时候",
  "而且",
  "还有",
  "然后",
  "直接",
  "因为",
]);

interface WordcloudCallbacks {
  sendPhoto: (photo: InputFile, caption: string) => Promise<void>;
}

interface WordPlacement {
  text: string;
  weight: number;
  fontSize: number;
  direction: "horizontal" | "vertical";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

let callbacks: WordcloudCallbacks | null = null;
let lastDate: string | null = null;
let fontsLoaded = false;
let jiebaLoaded = false;
const globalFonts = GlobalFonts as typeof GlobalFonts & { loadSystemFonts?: () => number };

function ensureFontsLoaded(): void {
  if (fontsLoaded) return;
  fontsLoaded = true;
  try {
    if (!globalFonts.has(BUNDLED_CJK_FONT_ALIAS)) {
      const registered = globalFonts.registerFromPath(
        BUNDLED_CJK_FONT_PATH,
        BUNDLED_CJK_FONT_ALIAS,
      );
      if (!registered) {
        logger.warn(
          { fontPath: BUNDLED_CJK_FONT_PATH },
          "wordcloud: bundled font registration failed",
        );
      }
    }
    globalFonts.loadSystemFonts?.();
  } catch (err) {
    logger.warn({ err }, "wordcloud: failed to load system fonts");
  }
}

function ensureJiebaLoaded(): void {
  if (jiebaLoaded) return;
  jiebaLoaded = true;
  try {
    nodejieba.load();
  } catch (err) {
    logger.warn({ err }, "wordcloud: failed to load nodejieba dictionaries");
  }
}

function hasReachedPublishTime(): boolean {
  const current = now();
  return current.hour() > 0 || (current.hour() === 0 && current.minute() >= 2);
}

function isMostlyCjk(token: string): boolean {
  const chars = Array.from(token);
  const cjkCount = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  return cjkCount > 0 && cjkCount >= Math.ceil(chars.length / 2);
}

function normalizeToken(token: string): string | null {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null;
  if (trimmed.startsWith("@")) return null;
  if (/^\p{Number}+$/u.test(trimmed)) return null;
  if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return null;
  if (STOP_WORDS.has(trimmed)) return null;
  if (/^[a-z0-9_-]+$/u.test(trimmed) && trimmed.length < 2) return null;
  if (isMostlyCjk(trimmed)) {
    if (trimmed.length === 1 && STOP_WORDS.has(trimmed)) return null;
    if (trimmed.length > 8) return null;
    return trimmed;
  }
  if (trimmed.length < 2) return null;
  if (trimmed.length > 24) return null;
  return trimmed;
}

function extractTokens(text: string): string[] {
  ensureJiebaLoaded();
  const sanitized = text
    .replace(/https?:\/\/[^\s]+/gu, " ")
    .replace(/@[\w_]+/gu, " ")
    .replace(/[#/][^\s]+/gu, " ")
    .replace(/[\r\n\t]+/gu, " ");
  const tokens: string[] = [];
  for (const segment of nodejieba.cut(sanitized, true)) {
    const normalized = normalizeToken(segment);
    if (normalized) tokens.push(normalized);
  }
  return tokens;
}

function shouldUseVerticalLayout(token: string): boolean {
  return isMostlyCjk(token) && Array.from(token).length >= 2;
}

function buildWordFrequencies(texts: string[]): { text: string; weight: number }[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const uniqueTokens = new Set(extractTokens(text));
    for (const token of uniqueTokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([text, weight]) => ({ text, weight }))
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.text.localeCompare(b.text, "zh-CN");
    })
    .slice(0, MAX_WORDS);
}

function collides(candidate: WordPlacement, placed: WordPlacement[]): boolean {
  return placed.some((item) => {
    return !(
      candidate.x + candidate.width < item.x ||
      item.x + item.width < candidate.x ||
      candidate.y + candidate.height < item.y ||
      item.y + item.height < candidate.y
    );
  });
}

function pickColor(index: number, weight: number): string {
  return COLORS[(index + weight) % COLORS.length] ?? COLORS[0];
}

function measureVerticalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
): { width: number; height: number } {
  const chars = Array.from(text);
  let maxCharWidth = fontSize;
  for (const char of chars) {
    const metrics = ctx.measureText(char);
    maxCharWidth = Math.max(maxCharWidth, metrics.width);
  }
  const lineHeight = Math.max(fontSize, Math.round(fontSize * 1.06));
  return {
    width: Math.ceil(maxCharWidth + WORD_PADDING * 2),
    height: Math.ceil(chars.length * lineHeight + WORD_PADDING * 2),
  };
}

function buildPlacements(words: { text: string; weight: number }[]): WordPlacement[] {
  ensureFontsLoaded();
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");
  const maxWeight = words[0]?.weight ?? 1;
  const minWeight = words[words.length - 1]?.weight ?? maxWeight;
  const span = Math.max(1, maxWeight - minWeight);
  const placed: WordPlacement[] = [];

  words.forEach((word, index) => {
    const ratio = maxWeight === minWeight ? 1 : (word.weight - minWeight) / span;
    const scaledRatio = Math.pow(ratio, WORD_SIZE_EXPONENT);
    const fontSize = Math.round(MIN_FONT_SIZE + scaledRatio * (MAX_FONT_SIZE - MIN_FONT_SIZE));
    const direction = shouldUseVerticalLayout(word.text) ? "vertical" : "horizontal";
    ctx.font = `700 ${fontSize}px ${DEFAULT_FONT_FAMILY}`;
    const { width, height } =
      direction === "vertical"
        ? measureVerticalText(ctx, word.text, fontSize)
        : (() => {
            const metrics = ctx.measureText(word.text);
            const textWidth = Math.max(metrics.width, fontSize);
            const textHeight = Math.max(
              metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
              fontSize,
            );
            return {
              width: Math.ceil(textWidth + WORD_PADDING * 2),
              height: Math.ceil(textHeight + WORD_PADDING * 2),
            };
          })();

    for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt += 1) {
      const angle = attempt * 0.37;
      const radius = 4 + attempt * 3.3;
      const centerX = CANVAS_SIZE / 2 + Math.cos(angle) * radius;
      const centerY = CANVAS_SIZE / 2 + Math.sin(angle) * radius;
      const candidate: WordPlacement = {
        text: word.text,
        weight: word.weight,
        fontSize,
        direction,
        x: Math.round(centerX - width / 2),
        y: Math.round(centerY - height / 2),
        width,
        height,
        color: pickColor(index, word.weight),
      };

      if (
        candidate.x < 18 ||
        candidate.y < 18 ||
        candidate.x + candidate.width > CANVAS_SIZE - 18 ||
        candidate.y + candidate.height > CANVAS_SIZE - 18
      ) {
        continue;
      }
      if (collides(candidate, placed)) continue;
      placed.push(candidate);
      return;
    }
  });

  return placed;
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  gradient.addColorStop(0, BACKGROUND_TOP);
  gradient.addColorStop(1, BACKGROUND_BOTTOM);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  for (let i = 0; i < 12; i += 1) {
    ctx.beginPath();
    ctx.fillStyle = i % 2 === 0 ? "rgba(255, 182, 204, 0.16)" : "rgba(173, 216, 255, 0.14)";
    const radius = 38 + i * 11;
    const x = 90 + (i % 4) * 250 + (i % 2) * 40;
    const y = 100 + Math.floor(i / 4) * 290 + (i % 3) * 20;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderWordcloudImage(words: { text: string; weight: number }[]): Buffer {
  ensureFontsLoaded();
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);
  const placements = buildPlacements(words);

  for (const placement of placements) {
    ctx.font = `700 ${placement.fontSize}px ${DEFAULT_FONT_FAMILY}`;
    ctx.shadowColor = "rgba(255,255,255,0.55)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = placement.color;
    if (placement.direction === "vertical") {
      const chars = Array.from(placement.text);
      const lineHeight = Math.max(placement.fontSize, Math.round(placement.fontSize * 1.06));
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const textX = placement.x + placement.width / 2;
      const startY = placement.y + WORD_PADDING;
      chars.forEach((char, index) => {
        ctx.fillText(char, textX, startY + index * lineHeight);
      });
      continue;
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const textX = placement.x + WORD_PADDING;
    const textY = placement.y + placement.height - WORD_PADDING;
    ctx.fillText(placement.text, textX, textY);
  }

  return canvas.toBuffer("image/png");
}

function buildCaption(params: {
  date: string;
  topUsers: ActiveUserStat[];
  hasForwardedMessages: boolean;
}): string {
  const { date, topUsers, hasForwardedMessages } = params;
  const today = todayDateStr();
  const yesterday = yesterdayDateStr();
  const introLine =
    date === today
      ? "来看看今天大哥哥们都在聊什么喵。"
      : date === yesterday
        ? "来看看昨天大哥哥们都在聊什么喵。"
        : `来看看 ${date} 那天大哥哥们都在聊什么喵。`;
  const rankingTitle =
    date === today
      ? "今日最活跃群友前五名："
      : date === yesterday
        ? "昨日最活跃群友前五名："
        : `${date} 最活跃群友前五名：`;
  const lines = [`${date} 词云`, "", introLine, "", rankingTitle];
  if (topUsers.length === 0) {
    lines.push("那天没有可统计的活人聊天记录喵。", "姬器人有点寂寞地蜷起来了喵。");
    return lines.join("\n");
  }
  topUsers.forEach((user, index) => {
    lines.push(`${index + 1}. ${user.displayName} ${user.messageCount}条`);
  });
  if (hasForwardedMessages) {
    lines.push("", "注：转发消息会计入活跃度，但不会进入词云正文喵。");
  }
  return lines.join("\n");
}

async function generateYesterdayWordcloud(date: string): Promise<void> {
  if (await hasWordcloudRunForDate(date)) {
    logger.info({ date }, "wordcloud: skipped already-published day");
    return;
  }

  const preview = await generateWordcloudPreviewForDate(date);
  if (!preview) {
    const pruned = await pruneStoredMessages();
    await markWordcloudRunForDate(date);
    logger.info({ date, pruned }, "wordcloud: skipped empty day");
    return;
  }

  const pruned = await pruneStoredMessages();
  logger.info(
    {
      date,
      messageCount: preview.messageCount,
      wordCount: preview.wordCount,
      pruned,
    },
    "wordcloud: generated image",
  );

  if (!callbacks) return;
  await callbacks.sendPhoto(new InputFile(preview.image, `${date}-wordcloud.png`), preview.caption);
  await markWordcloudRunForDate(date);
}

export async function generateWordcloudPreviewForDate(date: string): Promise<{
  image: Buffer;
  caption: string;
  messageCount: number;
  wordCount: number;
} | null> {
  const messages = await listStoredMessagesForDate(date);
  const topUsers = await listTopActiveUsersForDate(date, 5);
  const wordcloudMessages = messages.filter((message) => !message.isForwarded);
  const hasForwardedMessages = wordcloudMessages.length !== messages.length;
  const texts = wordcloudMessages
    .map((message) => message.text)
    .filter((text) => text.trim().length > 0);
  if (messages.length === 0 || texts.length === 0) {
    return null;
  }

  const words = buildWordFrequencies(texts);
  if (words.length === 0) {
    return null;
  }

  const image = renderWordcloudImage(words);
  const caption = buildCaption({ date, topUsers, hasForwardedMessages });
  return { image, caption, messageCount: messages.length, wordCount: words.length };
}

export function initWordcloudCallbacks(nextCallbacks: WordcloudCallbacks): void {
  callbacks = nextCallbacks;
}

export function checkAndGenerateWordcloud(): void {
  const today = todayDateStr();
  if (lastDate === null) {
    if (hasReachedPublishTime()) {
      const yesterdayDate = yesterdayDateStr();
      lastDate = today;
      generateYesterdayWordcloud(yesterdayDate).catch((err: unknown) => {
        logger.error({ err, yesterdayDate }, "wordcloud: startup catch-up failed");
      });
      return;
    }
    lastDate = today;
    return;
  }
  if (lastDate === today) return;
  if (!hasReachedPublishTime()) return;

  const yesterdayDate = lastDate;
  lastDate = today;

  generateYesterdayWordcloud(yesterdayDate).catch((err: unknown) => {
    logger.error({ err, yesterdayDate }, "wordcloud: checkAndGenerateWordcloud failed");
  });
}
