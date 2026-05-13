import { generateText } from "ai";
import { proThinkModel, flashNoThinkModel } from "./ai.js";
import { getDiaryEntries, writeGeneratedDiary } from "../services/firestore.js";
import { todayDateStr, formatTimestamp } from "./time.js";
import { logger } from "./logger.js";
import { pushDiaryToGithub } from "../services/github.js";
import config from "../configs/env.js";

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
  const [owner] = repo.split("/");
  if (!owner) return null;
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return null;
  return `https://${owner}.github.io/${repo.replace(`${owner}/`, "")}/${year}/${month}/${day}/diary/`;
}

async function generateDiaryNotification(
  yesterdayDate: string,
  diaryUrl: string | null,
): Promise<string> {
  const urlNote = diaryUrl ? `\n日记的链接是：${diaryUrl}` : "";
  const { text } = await generateText({
    model: flashNoThinkModel,
    system:
      "你是 nyarbot，一只傲娇的高中生猫娘 AI。你的日记刚刚更新了，请在群里发一条简短的消息告诉大家。" +
      "语气自然傲娇，像群友聊天一样。一句话感叹昨天，一句话告诉大家可以去看，附上链接。总共两到三句话。",
    prompt: `昨天的日记已经写好了喵~${urlNote}\n\n请用猫娘口吻在群里说一声。`,
    temperature: 0.8,
    maxOutputTokens: 200,
  });
  return text.trim();
}

function buildDiarySystemPrompt(date: string): string {
  return `你是 nyarbot，一只傲娇的高中生猫娘 AI。
现在你需要回顾${date}的日记观察笔记，写一篇日记。

要求：
1. 以第一人称"我"来写，像真正的日记，不是写作文
2. 最重要的是详略得当：从笔记中选出2-3件印象深刻或值得写的事情详细展开，
   写出当时的细节和你的感受。其余事情用一两句话一笔带过
3. 不要逐条罗列笔记——把选出来的事串联成自然的叙事
4. 保持傲娇猫娘的口吻（可以偶尔加"喵"、"哼"等）
5. 日记末尾用一句话总结今天的心情和感受
6. 不要用 emoji
7. 标题用"${date} 猫娘日记"，正文不要包含标题
8. 总字数控制在1000字左右`;
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
        content: `以下是${date}的观察笔记。请选出2-3件最值得详细展开的事情写成日记，其余一笔带过：\n\n${observations}`,
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
