import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InputFile } from "grammy";
import { GlobalFonts, createCanvas, type CanvasRenderingContext2D } from "@napi-rs/canvas";
import nodejieba from "nodejieba";
import {
  hasWordcloudRunForDate,
  hasWordcloudPublication,
  listStoredMessagesForDate,
  listTopActiveUsersForDate,
  markWordcloudPublication,
  markWordcloudRunForDate,
  pruneStoredMessages,
  type ActiveUserStat,
  type WordcloudPublicationSlot,
} from "../services/local-wordcloud-store.js";
import config from "../configs/env.js";
import { logger } from "./logger.js";
import { now, todayDateStr, yesterdayDateStr } from "./time.js";

const CANVAS_SIZE = 1024;
const WORDCLOUD_MAX_RETRY_ATTEMPTS = 3;
const WORDCLOUD_RETRY_DELAY_MS = 1200;
const MAX_WORDS = 80;
const MAX_LAYOUT_ATTEMPTS = 2200;
const MIN_FONT_SIZE = 36;
const MAX_FONT_SIZE = 190;
const MIN_PLACEMENT_FONT_SIZE = 22;
const WORD_PADDING = 4;
const WORD_SIZE_EXPONENT = 0.52;
const MAX_CORE_WORD_WIDTH_RATIO = 0.55;
const MAX_WORD_WIDTH_RATIO = 0.44;
const CENTER_CLUSTER_WORDS = 12;
const OUTER_MARGIN = 22;
const CORE_LAYOUT_WORDS = 6;
const CORE_FONT_SCALE = [1.08, 0.96, 0.93, 0.93, 0.9, 0.87] as const;
const CORE_ANCHORS = [
  { x: 0, y: 0 },
  { x: 0, y: -118 },
  { x: 148, y: -2 },
  { x: -154, y: 10 },
  { x: 0, y: 132 },
  { x: 146, y: 120 },
] as const;
const NEGATIVE_WORDS = new Set([
  "死",
  "滚",
  "杀",
  "傻",
  "蠢",
  "烂",
  "废",
  "屎",
  "妈",
  "操",
  "艹",
  "草泥马",
  "妈的",
  "傻逼",
  "傻比",
  "傻b",
  "sb",
  "弱智",
  "去死",
]);
const FUNCTION_WORDS = new Set(["的", "和", "与", "把", "被", "吧", "呢", "吗", "嘛"]);
const SINGLE_CHAR_STOP_WORDS = new Set([
  "这",
  "那",
  "哪",
  "会",
  "要",
  "来",
  "有",
  "能",
  "得",
  "不",
  "没",
  "很",
  "太",
  "更",
  "最",
  "还",
  "又",
  "再",
  "都",
  "就",
  "才",
  "也",
  "在",
  "去",
  "给",
  "让",
  "把",
  "被",
  "向",
  "对",
  "从",
  "到",
  "用",
  "像",
  "跟",
  "和",
  "与",
  "或",
  "并",
  "但",
  "而",
  "且",
  "哦",
  "啊",
  "呀",
  "呜",
  "嗯",
  "欸",
  "诶",
  "哈",
  "喔",
  "啦",
  "哇",
  "哎",
  "嘛",
  "呢",
  "吗",
  "吧",
  "喵",
  "人",
  "月",
  "日",
]);
const SINGLE_CHAR_KEEP_WORDS = new Set([
  "猫",
  "草",
  "娘",
  "涩",
  "萌",
  "香",
  "糖",
  "鸟",
  "瓜",
  "锅",
  "图",
  "饭",
  "酒",
  "药",
  "病",
  "雷",
]);
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
const WORDCLOUD_ARTIFACT_DIR = path.resolve(
  path.dirname(config.wordcloudDbPath),
  "wordcloud-artifacts",
);
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
  "和",
  "与",
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
  "把",
  "被",
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

export interface WordcloudArtifact {
  date: string;
  fileName: string;
  imagePath: string;
  image: Buffer;
  caption: string;
  messageCount: number;
  wordCount: number;
}

interface WordcloudArtifactMetadata {
  date: string;
  fileName: string;
  caption: string;
  messageCount: number;
  wordCount: number;
}

interface WordPlacement {
  text: string;
  sizeWeight: number;
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
const sameDayPublishInFlight = new Set<string>();
let fontsLoaded = false;
let jiebaLoaded = false;
const globalFonts = GlobalFonts as typeof GlobalFonts & { loadSystemFonts?: () => number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWordcloudTask<T>(
  label: string,
  task: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= WORDCLOUD_MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await task(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= WORDCLOUD_MAX_RETRY_ATTEMPTS) break;
      logger.warn(
        { err, label, attempt, maxAttempts: WORDCLOUD_MAX_RETRY_ATTEMPTS },
        "wordcloud: task failed, retrying",
      );
      await sleep(WORDCLOUD_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

function getWordcloudArtifactFileName(date: string): string {
  return `${date}-wordcloud.png`;
}

function getWordcloudArtifactPath(date: string): string {
  return path.join(WORDCLOUD_ARTIFACT_DIR, getWordcloudArtifactFileName(date));
}

function getWordcloudArtifactMetadataPath(date: string): string {
  return path.join(WORDCLOUD_ARTIFACT_DIR, `${date}-wordcloud.json`);
}

async function readWordcloudArtifact(date: string): Promise<WordcloudArtifact | null> {
  const imagePath = getWordcloudArtifactPath(date);
  const metadataPath = getWordcloudArtifactMetadataPath(date);
  try {
    await access(imagePath);
    await access(metadataPath);
    const [image, rawMetadata] = await Promise.all([
      readFile(imagePath),
      readFile(metadataPath, "utf-8"),
    ]);
    const metadata = JSON.parse(rawMetadata) as Partial<WordcloudArtifactMetadata>;
    if (
      metadata.date !== date ||
      typeof metadata.fileName !== "string" ||
      typeof metadata.caption !== "string" ||
      typeof metadata.messageCount !== "number" ||
      typeof metadata.wordCount !== "number"
    ) {
      return null;
    }
    return {
      date,
      fileName: metadata.fileName,
      imagePath,
      image,
      caption: metadata.caption,
      messageCount: metadata.messageCount,
      wordCount: metadata.wordCount,
    };
  } catch {
    return null;
  }
}

async function writeWordcloudArtifact(
  date: string,
  preview: { image: Buffer; caption: string; messageCount: number; wordCount: number },
): Promise<WordcloudArtifact> {
  await mkdir(WORDCLOUD_ARTIFACT_DIR, { recursive: true });
  const fileName = getWordcloudArtifactFileName(date);
  const imagePath = getWordcloudArtifactPath(date);
  const metadataPath = getWordcloudArtifactMetadataPath(date);
  const metadata: WordcloudArtifactMetadata = {
    date,
    fileName,
    caption: preview.caption,
    messageCount: preview.messageCount,
    wordCount: preview.wordCount,
  };
  await Promise.all([
    writeFile(imagePath, preview.image),
    writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8"),
  ]);
  return {
    date,
    fileName,
    imagePath,
    image: preview.image,
    caption: preview.caption,
    messageCount: preview.messageCount,
    wordCount: preview.wordCount,
  };
}

function buildPublicationArtifactDate(date: string, slot: WordcloudPublicationSlot): string {
  return slot === "daily_rollup_yesterday" ? date : `${date}-${slot}`;
}

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

function getCurrentSameDayPublicationSlot(): WordcloudPublicationSlot | null {
  const hour = now().hour();
  if (hour >= 20) return "same_day_evening";
  if (hour >= 12) return "same_day_noon";
  return null;
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
  if (FUNCTION_WORDS.has(trimmed)) return null;
  if (NEGATIVE_WORDS.has(trimmed)) return null;
  if (/^[a-z0-9_-]+$/u.test(trimmed) && trimmed.length < 2) return null;
  if (isMostlyCjk(trimmed)) {
    if (trimmed.length === 1 && SINGLE_CHAR_STOP_WORDS.has(trimmed)) return null;
    if (trimmed.length === 1 && STOP_WORDS.has(trimmed)) return null;
    if (trimmed.length === 1 && FUNCTION_WORDS.has(trimmed)) return null;
    if (trimmed.length === 1 && NEGATIVE_WORDS.has(trimmed)) return null;
    if (trimmed.length > 8) return null;
    return trimmed;
  }
  if (trimmed.length < 2) return null;
  if (trimmed.length > 24) return null;
  return trimmed;
}

function getTokenRankingWeight(token: string, count: number): number {
  const length = Array.from(token).length;
  if (isMostlyCjk(token) && length === 1) {
    if (!SINGLE_CHAR_KEEP_WORDS.has(token) && count < 3) return 0;
    const baseMultiplier = SINGLE_CHAR_KEEP_WORDS.has(token) ? 0.4 : 0.22;
    const frequencyBoost = count >= 8 ? 1.15 : count >= 5 ? 1.05 : 1;
    return count * baseMultiplier * frequencyBoost;
  }
  if (length === 2) return count * 1.12;
  if (length === 3) return count * 1.2;
  if (length >= 4) return count * 1.26;
  return count;
}

function getTokenSizeWeight(token: string, count: number): number {
  const length = Array.from(token).length;
  if (isMostlyCjk(token) && length === 1) {
    return count * (SINGLE_CHAR_KEEP_WORDS.has(token) ? 0.58 : 0.42);
  }
  return count;
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
  const chars = Array.from(token);
  return isMostlyCjk(token) && chars.length >= 2 && chars.length <= 3;
}

function buildWordFrequencies(texts: string[]): { text: string; sizeWeight: number }[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const uniqueTokens = new Set(extractTokens(text));
    for (const token of uniqueTokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const ranked = Array.from(counts.entries())
    .map(([text, count]) => ({
      text,
      count,
      rankWeight: getTokenRankingWeight(text, count),
      sizeWeight: getTokenSizeWeight(text, count),
    }))
    .filter((entry) => entry.rankWeight > 0)
    .sort((a, b) => {
      if (b.rankWeight !== a.rankWeight) return b.rankWeight - a.rankWeight;
      if (b.count !== a.count) return b.count - a.count;
      return a.text.localeCompare(b.text, "zh-CN");
    })
    .slice(0, MAX_WORDS);

  return ranked
    .sort((a, b) => {
      if (b.sizeWeight !== a.sizeWeight) return b.sizeWeight - a.sizeWeight;
      if (b.count !== a.count) return b.count - a.count;
      if (b.rankWeight !== a.rankWeight) return b.rankWeight - a.rankWeight;
      return a.text.localeCompare(b.text, "zh-CN");
    })
    .map(({ text, sizeWeight }) => ({ text, sizeWeight }));
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
  const lineHeight = Math.max(fontSize, Math.round(fontSize * 0.94));
  return {
    width: Math.ceil(maxCharWidth + WORD_PADDING * 2),
    height: Math.ceil(chars.length * lineHeight + WORD_PADDING * 2),
  };
}

function measureHorizontalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
): { width: number; height: number } {
  const metrics = ctx.measureText(text);
  const textWidth = Math.max(metrics.width, fontSize);
  const textHeight = Math.max(
    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    fontSize,
  );
  return {
    width: Math.ceil(textWidth + WORD_PADDING * 2),
    height: Math.ceil(textHeight + WORD_PADDING * 2),
  };
}

function getDisplayWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(text)) {
    width += /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)
      ? 2
      : 1;
  }
  return width;
}

function padToDisplayWidth(text: string, width: number): string {
  const currentWidth = getDisplayWidth(text);
  if (currentWidth >= width) return text;
  return text + " ".repeat(width - currentWidth);
}

function buildPlacementCandidate(
  index: number,
  attempt: number,
  width: number,
  height: number,
): { x: number; y: number } {
  if (index < CORE_LAYOUT_WORDS) {
    const anchor = CORE_ANCHORS[index] ?? CORE_ANCHORS[0];
    const radius = attempt === 0 ? 0 : 4 + attempt * 5.4;
    const angle = index * 0.95 + attempt * 0.42;
    const centerX = CANVAS_SIZE / 2 + anchor.x + Math.cos(angle) * radius;
    const centerY = CANVAS_SIZE / 2 + anchor.y + Math.sin(angle) * radius * 0.72;
    return {
      x: Math.round(centerX - width / 2),
      y: Math.round(centerY - height / 2),
    };
  }

  const isCoreWord = index < 4;
  const isCenterWord = index < CENTER_CLUSTER_WORDS;
  const angleOffset = isCoreWord ? ([-1.05, 0.62, 2.35, 3.82][index] ?? index * 0.7) : index * 0.91;
  const goldenAngle = 2.399963229728653;
  const orbitAngle = angleOffset + attempt * goldenAngle;
  const attemptProgress = Math.sqrt(attempt + 1);
  const compactness = isCoreWord ? 0.22 : isCenterWord ? 0.42 : 0.78;
  const radius = 8 + attemptProgress * (isCenterWord ? 15 : 21) * compactness;
  const waveX = Math.sin(attempt * 0.35 + index * 0.6) * (isCenterWord ? 22 : 34);
  const waveY = Math.cos(attempt * 0.28 + index * 0.48) * (isCenterWord ? 16 : 26);
  const centerX =
    CANVAS_SIZE / 2 + Math.cos(orbitAngle) * radius * (isCenterWord ? 0.94 : 1.02) + waveX;
  const centerY =
    CANVAS_SIZE / 2 + Math.sin(orbitAngle) * radius * (isCenterWord ? 0.8 : 0.92) + waveY;
  return {
    x: Math.round(centerX - width / 2),
    y: Math.round(centerY - height / 2),
  };
}

function buildPlacements(words: { text: string; sizeWeight: number }[]): WordPlacement[] {
  ensureFontsLoaded();
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");
  const maxWeight = words[0]?.sizeWeight ?? 1;
  const minWeight = words[words.length - 1]?.sizeWeight ?? maxWeight;
  const span = Math.max(1, maxWeight - minWeight);
  const placed: WordPlacement[] = [];

  words.forEach((word, index) => {
    const ratio = maxWeight === minWeight ? 1 : (word.sizeWeight - minWeight) / span;
    const scaledRatio = Math.pow(ratio, WORD_SIZE_EXPONENT);
    const baseFontSize = MIN_FONT_SIZE + scaledRatio * (MAX_FONT_SIZE - MIN_FONT_SIZE);
    const fontScale = CORE_FONT_SCALE[index] ?? 1;
    const initialFontSize = Math.round(baseFontSize * fontScale);
    const direction =
      index < 18 || !shouldUseVerticalLayout(word.text) || ratio > 0.3 ? "horizontal" : "vertical";

    for (
      let fontSize = initialFontSize;
      fontSize >= MIN_PLACEMENT_FONT_SIZE;
      fontSize -= fontSize > 72 ? 10 : fontSize > 40 ? 6 : 4
    ) {
      ctx.font = `700 ${fontSize}px ${DEFAULT_FONT_FAMILY}`;
      let measuredFontSize = fontSize;
      let box =
        direction === "vertical"
          ? measureVerticalText(ctx, word.text, measuredFontSize)
          : measureHorizontalText(ctx, word.text, measuredFontSize);

      if (direction === "horizontal") {
        const maxWidth = Math.floor(
          CANVAS_SIZE *
            (index < CORE_LAYOUT_WORDS ? MAX_CORE_WORD_WIDTH_RATIO : MAX_WORD_WIDTH_RATIO),
        );
        if (box.width > maxWidth) {
          measuredFontSize = Math.max(
            MIN_PLACEMENT_FONT_SIZE,
            Math.floor((measuredFontSize * maxWidth) / box.width),
          );
          ctx.font = `700 ${measuredFontSize}px ${DEFAULT_FONT_FAMILY}`;
          box = measureHorizontalText(ctx, word.text, measuredFontSize);
        }
      }

      const { width, height } = box;

      for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt += 1) {
        const { x, y } = buildPlacementCandidate(index, attempt, width, height);
        const candidate: WordPlacement = {
          text: word.text,
          sizeWeight: word.sizeWeight,
          fontSize: measuredFontSize,
          direction,
          x,
          y,
          width,
          height,
          color: pickColor(index, Math.round(word.sizeWeight)),
        };

        if (
          candidate.x < OUTER_MARGIN ||
          candidate.y < OUTER_MARGIN ||
          candidate.x + candidate.width > CANVAS_SIZE - OUTER_MARGIN ||
          candidate.y + candidate.height > CANVAS_SIZE - OUTER_MARGIN
        ) {
          continue;
        }
        if (collides(candidate, placed)) continue;
        placed.push(candidate);
        return;
      }
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

  for (let i = 0; i < 6; i += 1) {
    ctx.beginPath();
    ctx.fillStyle = i % 2 === 0 ? "rgba(255, 182, 204, 0.055)" : "rgba(173, 216, 255, 0.05)";
    const radius = 52 + i * 10;
    const x = 150 + (i % 3) * 305 + (i % 2) * 18;
    const y = 155 + Math.floor(i / 3) * 300 + (i % 3) * 14;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderWordcloudImage(words: { text: string; sizeWeight: number }[]): Buffer {
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
  messageCount: number;
}): string {
  const { date, topUsers, messageCount } = params;
  const today = todayDateStr();
  const yesterday = yesterdayDateStr();
  const [, month, day] = date.split("-").map((part) => Number(part));
  const titleDate = Number.isFinite(month) && Number.isFinite(day) ? `${month}月${day}日` : date;
  const shortDate = date === today ? "今天" : date === yesterday ? "昨天" : titleDate;
  const introLine =
    date === today
      ? "来看看大哥哥们今天都在聊什么喵~"
      : date === yesterday
        ? "来看看大哥哥们昨天都在聊什么喵~"
        : `来看看大哥哥们在 ${titleDate} 都聊了什么喵~`;
  const rankingTitle =
    date === today
      ? "今日活跃用户排行榜："
      : date === yesterday
        ? "昨日活跃用户排行榜："
        : `${titleDate} 活跃用户排行榜：`;
  const lines = [
    `${shortDate}的热门话题 ${date === yesterday ? "🐾" : "✨"}`,
    "",
    introLine,
    "",
    `${shortDate}一共有${messageCount}条发言 💬`,
    "",
    "看看有没有你感兴趣的关键词喵 ฅ^•ω•^ฅ",
    "",
    "",
    rankingTitle,
    "",
  ];
  if (topUsers.length === 0) {
    lines.push("那天没有可统计的活人聊天记录喵。", "姬器人有点寂寞地蜷起来了喵。");
    return lines.join("\n");
  }
  const rankBadges = ["🥇", "🥈", "🥉", "🏅", "🎖️"] as const;
  const maxNameWidth = topUsers.reduce(
    (max, user) => Math.max(max, getDisplayWidth(user.displayName)),
    0,
  );
  const maxCountWidth = topUsers.reduce(
    (max, user) => Math.max(max, String(user.messageCount).length),
    0,
  );
  topUsers.forEach((user, index) => {
    const badge = rankBadges[index] ?? `${index + 1}.`;
    const name = padToDisplayWidth(user.displayName, maxNameWidth);
    const count = String(user.messageCount).padStart(maxCountWidth, " ");
    lines.push(`${badge} ${name} ${count}条`);
  });
  lines.push("", "感谢大哥哥们的积极发言喵 🐱");
  return lines.join("\n");
}

async function generateYesterdayWordcloud(date: string): Promise<void> {
  if (await hasWordcloudRunForDate(date)) {
    logger.info({ date }, "wordcloud: skipped already-published day");
    return;
  }
  await publishWordcloudForDate({
    date,
    slot: "daily_rollup_yesterday",
    markPublished: () => markWordcloudRunForDate(date),
  });
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
  const caption = buildCaption({
    date,
    topUsers,
    messageCount: messages.length,
  });
  return { image, caption, messageCount: messages.length, wordCount: words.length };
}

export async function generateWordcloudPreviewForDateWithRetry(date: string): Promise<{
  image: Buffer;
  caption: string;
  messageCount: number;
  wordCount: number;
} | null> {
  return retryWordcloudTask("generate wordcloud preview", async () => {
    return await generateWordcloudPreviewForDate(date);
  });
}

export async function ensureWordcloudArtifactForDate(
  date: string,
): Promise<WordcloudArtifact | null> {
  const existing = await readWordcloudArtifact(date);
  if (existing) return existing;
  const preview = await generateWordcloudPreviewForDate(date);
  if (!preview) return null;
  return writeWordcloudArtifact(date, preview);
}

export async function ensureWordcloudArtifactForDateWithRetry(
  date: string,
): Promise<WordcloudArtifact | null> {
  return retryWordcloudTask("ensure wordcloud artifact", async () => {
    return await ensureWordcloudArtifactForDate(date);
  });
}

async function ensureWordcloudArtifactForPublication(
  date: string,
  slot: WordcloudPublicationSlot,
): Promise<WordcloudArtifact | null> {
  if (slot === "daily_rollup_yesterday") {
    return ensureWordcloudArtifactForDate(date);
  }
  const preview = await generateWordcloudPreviewForDate(date);
  if (!preview) return null;
  return writeWordcloudArtifact(buildPublicationArtifactDate(date, slot), preview);
}

async function ensureWordcloudArtifactForPublicationWithRetry(
  date: string,
  slot: WordcloudPublicationSlot,
): Promise<WordcloudArtifact | null> {
  return retryWordcloudTask(`ensure wordcloud artifact ${slot}`, async () => {
    return await ensureWordcloudArtifactForPublication(date, slot);
  });
}

async function publishWordcloudForDate(params: {
  date: string;
  slot: WordcloudPublicationSlot;
  markPublished: () => Promise<void>;
}): Promise<void> {
  const { date, slot, markPublished } = params;
  const artifact = await ensureWordcloudArtifactForPublicationWithRetry(date, slot);
  if (!artifact) {
    if (slot === "daily_rollup_yesterday") {
      const pruned = await pruneStoredMessages();
      await markPublished();
      logger.info({ date, slot, pruned }, "wordcloud: skipped empty publication");
      return;
    }
    await markPublished();
    logger.info({ date, slot }, "wordcloud: skipped empty same-day publication");
    return;
  }

  if (slot === "daily_rollup_yesterday") {
    const pruned = await pruneStoredMessages();
    logger.info(
      { date, slot, messageCount: artifact.messageCount, wordCount: artifact.wordCount, pruned },
      "wordcloud: generated image",
    );
  } else {
    logger.info(
      { date, slot, messageCount: artifact.messageCount, wordCount: artifact.wordCount },
      "wordcloud: generated same-day image",
    );
  }

  const currentCallbacks = callbacks;
  if (!currentCallbacks) return;
  await retryWordcloudTask(`publish wordcloud photo ${slot}`, async () => {
    await currentCallbacks.sendPhoto(
      new InputFile(artifact.image, artifact.fileName),
      artifact.caption,
    );
  });
  await markPublished();
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
    }
    lastDate = today;
  }

  const slot = getCurrentSameDayPublicationSlot();
  if (slot) {
    const sameDayCheckKey = `${today}:${slot}`;
    if (!sameDayPublishInFlight.has(sameDayCheckKey)) {
      sameDayPublishInFlight.add(sameDayCheckKey);
      hasWordcloudPublication(today, slot)
        .then((published) => {
          if (published) return;
          return publishWordcloudForDate({
            date: today,
            slot,
            markPublished: () => markWordcloudPublication(today, slot),
          });
        })
        .catch((err: unknown) => {
          logger.error({ err, today, slot }, "wordcloud: same-day publish failed");
        })
        .finally(() => {
          sameDayPublishInFlight.delete(sameDayCheckKey);
        });
    }
  }

  if (lastDate === today) return;
  if (!hasReachedPublishTime()) return;

  const yesterdayDate = lastDate;
  lastDate = today;

  generateYesterdayWordcloud(yesterdayDate).catch((err: unknown) => {
    logger.error({ err, yesterdayDate }, "wordcloud: checkAndGenerateWordcloud failed");
  });
}
