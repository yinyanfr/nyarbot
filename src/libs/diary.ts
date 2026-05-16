import { generateText } from "ai";
import { proThinkModel, flashNoThinkModel } from "./ai.js";
import { getDiaryEntries, writeGeneratedDiary } from "../services/firestore.js";
import { todayDateStr, formatTimestamp } from "./time.js";
import { logger } from "./logger.js";
import { pushDiaryToGithub } from "../services/github.js";
import config from "../configs/env.js";
import { getPersonaLabel } from "./persona.js";

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

let lastDate: string | null = null;

export interface DiaryCallbacks {
  sendText: (text: string) => Promise<void>;
}

let diaryCallbacks: DiaryCallbacks | null = null;

export function initDiaryCallbacks(callbacks: DiaryCallbacks): void {
  diaryCallbacks = callbacks;
}

function buildDiaryUrl(date: string): string | null {
  const repo = config.githubRepo;
  if (!repo) return null;
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return null;
  return `https://${owner}.github.io/${repoName}/${date}-diary/`;
}

async function generateDiaryNotification(
  yesterdayDate: string,
  diaryUrl: string | null,
): Promise<string> {
  const urlNote = diaryUrl ? `\n日记的链接是：${diaryUrl}` : "";
  const { text } = await generateText({
    model: flashNoThinkModel,
    system: `<diary_notification_system><persona>${xmlEscape(getPersonaLabel())}</persona><task>日记更新后在群里发通知</task><tone>自然傲娇、群友口吻</tone><constraints><length>2-3句</length><structure>一句感叹昨天，一句提示可查看并附链接</structure></constraints></diary_notification_system>`,
    prompt: `<diary_notification_request><date>${xmlEscape(yesterdayDate)}</date><url>${xmlEscape(diaryUrl ?? "")}</url><extra>${xmlEscape(urlNote)}</extra><output>仅输出通知文本</output></diary_notification_request>`,
    temperature: 0.8,
    maxOutputTokens: 200,
  });
  return text.trim();
}

function buildDiarySystemPrompt(date: string): string {
  return `<diary_generation_system>
  <persona>${xmlEscape(getPersonaLabel())}</persona>
  <date>${xmlEscape(date)}</date>
  <task>根据观察笔记写一篇第一人称日记</task>
  <requirements>
    <item>以“我”叙述，像真实日记，不是作文</item>
    <item>从笔记中选 2-3 件最值得写的事详细展开，其余简略带过</item>
    <item>不要逐条罗列，要串成自然叙事</item>
    <item>保持轻微傲娇猫娘口吻</item>
    <item>结尾一句总结当天心情</item>
    <item>不要使用 emoji</item>
    <item>标题为“${xmlEscape(date)} 猫娘日记”，正文不重复标题</item>
    <item>总字数约 1000 字</item>
  </requirements>
</diary_generation_system>`;
}

export async function generateDiaryForDate(date: string): Promise<string | null> {
  const entries = await getDiaryEntries(date);
  if (entries.length === 0) {
    logger.info({ date }, "diary: no entries for date, returning null");
    return null;
  }

  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const observations = sorted
    .map((e) => `[${formatTimestamp(e.ts, "HH:mm")}] ${e.content}`)
    .join("\n");

  logger.info({ date, count: sorted.length }, "diary: generating diary from entries");

  const { text } = await generateText({
    model: proThinkModel,
    system: buildDiarySystemPrompt(date),
    messages: [
      {
        role: "user" as const,
        content: `<diary_generation_request><date>${xmlEscape(date)}</date><notes>${xmlEscape(observations)}</notes><instruction>选出2-3件最值得详细展开的事情写成日记，其余一笔带过</instruction></diary_generation_request>`,
      },
    ],
    maxOutputTokens: 3000,
  });

  const diary = text.trim();
  if (!diary) {
    logger.warn({ date }, "diary: model returned empty diary");
    return null;
  }

  logger.info({ date, len: diary.length }, "diary: generated diary for date");
  return diary;
}

async function generateYesterdayDiary(yesterdayDate: string): Promise<void> {
  try {
    const diary = await generateDiaryForDate(yesterdayDate);
    if (!diary) return;

    await writeGeneratedDiary(yesterdayDate, diary);
    logger.info({ yesterdayDate, len: diary.length }, "diary: generated and saved");

    pushDiaryToGithub(yesterdayDate, diary).catch((err: unknown) => {
      logger.warn({ err, yesterdayDate }, "diary: GitHub push failed");
    });

    if (diaryCallbacks) {
      const diaryUrl = buildDiaryUrl(yesterdayDate);
      generateDiaryNotification(yesterdayDate, diaryUrl)
        .then((notification) => diaryCallbacks!.sendText(notification))
        .catch((err: unknown) => {
          logger.warn({ err }, "diary: notification send failed");
        });
    }
  } catch (err) {
    logger.error({ err, yesterdayDate }, "diary: generation failed");
  }
}

export function checkAndGenerateDiary(): void {
  const today = todayDateStr();
  if (lastDate === null) {
    lastDate = today;
    return;
  }
  if (lastDate === today) return;

  const yesterdayDate = lastDate;
  lastDate = today;

  generateYesterdayDiary(yesterdayDate).catch((err: unknown) => {
    logger.error({ err }, "diary: checkAndGenerateDiary failed");
  });
}
