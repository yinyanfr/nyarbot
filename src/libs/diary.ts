import { generateText } from "ai";
import { proThinkModel } from "./ai.js";
import { getDiaryEntries, writeGeneratedDiary } from "../services/firestore.js";
import { todayDateStr, formatTimestamp } from "./time.js";
import { logger } from "./logger.js";
import { pushDiaryToGithub } from "../services/github.js";

let lastDate: string | null = null;

function buildDiarySystemPrompt(date: string): string {
  return `你是 nyarbot，一只傲娇的高中生猫娘 AI。
现在你需要回顾${date}的日记观察笔记，用自然的中文写一篇日记。
要求：
1. 以第一人称"我"来写
2. 像高中生写日记和记叙文一样，有自然的叙事顺序
3. 把观察笔记串联成一个连贯的故事，而不是逐条罗列
4. 保持傲娇猫娘的口吻（可以偶尔加"喵"、"哼"等）
5. 日记末尾可以有一两句话总结这一天的心情
6. 不要用 emoji
7. 标题用"${date} 猫娘日记"，正文不要包含标题`;
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
        content: `以下是${date}的观察笔记，请写成一篇日记：\n\n${observations}`,
      },
    ],
    maxOutputTokens: 4000,
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
