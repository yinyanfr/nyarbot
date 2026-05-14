import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { initFirebase } from "../services/index.js";
import { logger } from "../libs/logger.js";

initFirebase();
const db = getFirestore();

async function main(): Promise<void> {
  const stickersSnap = await db.collection("stickers").get();
  const count = stickersSnap.size;
  logger.info({ count }, "copying stickers to received_stickers...");

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of stickersSnap.docs) {
    const data = doc.data();
    try {
      const receivedRef = db.collection("received_stickers").doc(data.file_id);
      const existing = await receivedRef.get();
      if (existing.exists) {
        skipped++;
        continue;
      }

      await receivedRef.set({
        file_id: data.file_id,
        emoji: data.emoji,
        description: data.description,
        keywords: data.keywords ?? [],
        receivedAt: Date.now(),
      });
      updated++;
    } catch (err) {
      logger.error({ err, file_id: data.file_id }, "failed to copy sticker");
      failed++;
    }
  }

  logger.info({ count, updated, skipped, failed }, "sync complete");
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "sync failed");
  process.exit(1);
});
