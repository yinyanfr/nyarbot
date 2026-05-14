import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { initFirebase } from "../services/index.js";
import { describeSticker } from "../libs/ai.js";
import { downloadTelegramStickerAsDataUrl } from "../libs/telegram-image.js";
import { logger } from "../libs/logger.js";

initFirebase();
const db = getFirestore();

async function main(): Promise<void> {
  const stickersSnap = await db.collection("stickers").get();
  const count = stickersSnap.size;
  logger.info({ count }, "rewriting sticker descriptions with keywords...");

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of stickersSnap.docs) {
    const data = doc.data();
    const fileId = data.file_id as string;
    try {
      logger.info({ fileId, oldDesc: data.description?.slice(0, 40) }, "processing...");

      const dataUrl = await downloadTelegramStickerAsDataUrl(fileId);
      if (!dataUrl) {
        logger.warn({ fileId }, "failed to download sticker, skipping");
        skipped++;
        continue;
      }

      const result = await describeSticker(dataUrl);
      if (!result) {
        logger.warn({ fileId }, "describeSticker returned null, skipping");
        skipped++;
        continue;
      }

      await doc.ref.set(
        {
          description: result.description,
          keywords: result.keywords,
        },
        { merge: true },
      );

      // Also update received_stickers if this sticker was synced
      const receivedRef = db.collection("received_stickers").doc(fileId);
      const receivedSnap = await receivedRef.get();
      if (receivedSnap.exists) {
        await receivedRef.set(
          {
            description: result.description,
            keywords: result.keywords,
          },
          { merge: true },
        );
      }

      updated++;
      logger.info({ fileId, desc: result.description, keywords: result.keywords }, "updated");
    } catch (err) {
      logger.error({ err, fileId }, "failed to rewrite sticker");
      failed++;
    }
  }

  logger.info({ count, updated, skipped, failed }, "rewrite complete");
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "rewrite failed");
  process.exit(1);
});
