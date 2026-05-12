import "dotenv/config";
import { initFirebase } from "../services/index.js";
import { describeSticker } from "../libs/ai.js";
import { saveSticker } from "../libs/sticker-store.js";
import { downloadTelegramStickerAsDataUrl } from "../libs/telegram-image.js";
import { logger } from "../libs/logger.js";

// Miaohaha sticker pack — hardcoded emoji → file_id mapping (migrated to Firestore)
const HARDCODED_STICKERS: Record<string, string> = {
  "😟": "CAACAgQAAxUAAWn7XfOLviBCGbaABERYcVitEgh5AALkEAACVx-JUpCvszWBeKWVOwQ",
  "❔": "CAACAgQAAxUAAWn7XfNe4nr4IE-9Ul6Qi3Z29-WXAALmDAAC7peJUrEHq3uhAhZMOwQ",
  "🙃": "CAACAgQAAxUAAWn7XfPOykZxYkiQN-bq18p9VB-0AAInEAACGv2JUtPsDLhNZLttOwQ",
  "🎉": "CAACAgQAAxUAAWn7XfP6Y64T65Wn0pd9P-QCTx2rAALLDQACMrOIUi5yVeOUcc1WOwQ",
  "😏": "CAACAgQAAxUAAWn7XfOUUQpwGEjjug_roy-rktSfAALWDQACTTWJUgW9Dz1qweo3OwQ",
  "🥺": "CAACAgQAAxUAAWn7XfPa_Pu1Z1RmFZXNVF8hayKHAALIDQACpliJUmoD-P2XTiWkOwQ",
  "💕": "CAACAgQAAxUAAWn7XfMtio2aohAuSGT7s65rJZ29AAKMDwACXIeJUlnR9NXg7020OwQ",
  "😀": "CAACAgQAAxUAAWn7XfNHDLw2Rs4ljiSFyGtc6y3mAALnFAAC0RaJUkvGz2f2CqxwOwQ",
  "🤔": "CAACAgQAAxUAAWn7XfNzPtUty7S4LEzyIZJLtndAAAJuDwACaTeIUiYlj2J30W5hOwQ",
  "☕️": "CAACAgQAAxUAAWn7XfPfs8d2w4OnSafe3lfuvXNkAAJJEgACUe2IUq1qnM1GoHzDOwQ",
  "😐": "CAACAgQAAxUAAWn7XfOSF6jVjCcw6UJFEQxSik5ZAALvDQACum6JUiyeIMIQLZSvOwQ",
  "🫤": "CAACAgQAAxUAAWn7XfPiQMLcz3e3cDBFsBs4dI4SAAKEDwACgY6RUlIbLdZSnXmaOwQ",
  "😔": "CAACAgQAAxUAAWn7XfMzzpqlSkVWzi32PT-vZm57AAIkDgACbpqIUo4inUPrm1IGOwQ",
  "👮": "CAACAgQAAxUAAWn7XfPC3Fd97DRUBgTqTXROj01lAAI2DwACYxSJUvExPRQpskD0OwQ",
  "😭": "CAACAgQAAxUAAWn7XfPnEoRpykXAtw05zpBz_c_nAAInEAACrxuJUvaAoU9oUCu4OwQ",
  "😮": "CAACAgQAAxUAAWn7XfOmFy8cVzIogpYabzIxVyhHAAIWDgAC5daJUseEKV_cNVyDOwQ",
  "😯": "CAACAgQAAxUAAWn7XfOTqpOpZmXcpkPlaWSYoJxtAALuDAACTXmQUsRCGjHpKjUQOwQ",
  "😛": "CAACAgQAAxUAAWn7XfPU6wFpuWMODfoxjRK_QMO9AAJ0DwAC0_6IUj27Xt-R1-fZOwQ",
  "🐱": "CAACAgQAAxUAAWn7XfNXaYEiCKUMH3bD4JDr6mk2AAJeEgAC43aJUiGBCEXJRnFSOwQ",
  "🌟": "CAACAgQAAxUAAWn7XfNCV5jt9cRDOx91tbeOnevkAAJvDwAC5l2JUkos-HjmOl3kOwQ",
  "🤝": "CAACAgQAAxUAAWn7XfPcAk6EhbMumYmj-Cdq77AJAAIEDwAC54WIUj-bwz7TQQABRTsE",
  "😶": "CAACAgQAAxUAAWn7XfP-oZw5RPKlWedt8biEh2JtAALSEgAC7-2IUsVeb_a2QeB2OwQ",
  "🙌": "CAACAgQAAxUAAWn7XfMVkRh-1IxVNUPTIjj-ooY6AALyDgACPpqRUlly0cUQmCd1OwQ",
  "👏": "CAACAgQAAxUAAWn7XfNU5ii4PGVMJcCQTurizdMUAAJYDgAC81eIUpjc5FJxEiQlOwQ",
  "😢": "CAACAgQAAxUAAWn7XfPQQL8G7SSzZdBfPxRZUfmiAAKpDgAC_AyIUoKo75CnL9qcOwQ",
  "👊": "CAACAgQAAxUAAWn7XfMK0AZvAh9wc3mh5AtVsGMiAAIpDwACeBWRUlECPcGJGfrkOwQ",
  "🤭": "CAACAgQAAxUAAWn7XfMWRJOBDqj1Vqc4pOcSWB1LAAKhDgACgtqJUiUO4uNfIp-gOwQ",
  "😠": "CAACAgQAAxUAAWn7XfMrdr9_K-LTNHwDOylAIKqqAAJbDAACb8yRUiIM8E4h5q4QOwQ",
  "😒": "CAACAgQAAxUAAWn7XfNkUd4vkJKk8u0nyZYrNpLhAALcDQACBfuIUqLtahMXgr5fOwQ",
};

const STICKER_COUNT = Object.keys(HARDCODED_STICKERS).length;

async function main(): Promise<void> {
  initFirebase();
  logger.info(`migrating ${STICKER_COUNT} hardcoded stickers to Firestore...`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const [emoji, fileId] of Object.entries(HARDCODED_STICKERS)) {
    try {
      logger.info({ emoji, fileId }, "processing sticker...");

      const dataUrl = await downloadTelegramStickerAsDataUrl(fileId);
      if (!dataUrl) {
        logger.warn({ fileId }, "failed to download sticker, skipping");
        skipped++;
        continue;
      }

      const desc = await describeSticker(dataUrl);
      if (!desc) {
        logger.warn({ fileId }, "sticker description failed, skipping");
        skipped++;
        continue;
      }

      await saveSticker({
        file_id: fileId,
        emoji: [emoji],
        description: desc,
        source: "migration",
      });

      success++;
      logger.info({ emoji, fileId, desc }, "saved");
    } catch (err) {
      logger.error({ err, emoji, fileId }, "failed to migrate sticker");
      failed++;
    }
  }

  logger.info({ success, skipped, failed }, "migration complete");
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
