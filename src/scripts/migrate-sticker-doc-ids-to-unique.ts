import "dotenv/config";
import { Bot } from "grammy";
import { getFirestore } from "firebase-admin/firestore";
import config from "../configs/env.js";
import { logger } from "../libs/logger.js";
import { initFirebase } from "../services/index.js";

type DocData = Record<string, unknown>;

interface MigrationStats {
  scanned: number;
  migrated: number;
  deletedOld: number;
  skipped: number;
  failed: number;
}

initFirebase();
const db = getFirestore();
const bot = new Bot(config.botApiKey);

function pickSortTimestamp(data: DocData): number {
  const candidates = [data.receivedAt, data.adoptedAt, data.generatedAt, data.cachedAt];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return 0;
}

async function resolveUniqueId(fileId: string): Promise<string | null> {
  try {
    const f = await bot.api.getFile(fileId);
    return f.file_unique_id || null;
  } catch (err) {
    logger.warn({ err, fileId }, "getFile failed while resolving file_unique_id");
    return null;
  }
}

async function migrateCollection(name: "stickers" | "received_stickers"): Promise<MigrationStats> {
  const stats: MigrationStats = {
    scanned: 0,
    migrated: 0,
    deletedOld: 0,
    skipped: 0,
    failed: 0,
  };

  const snap = await db.collection(name).get();
  const docs = [...snap.docs].sort((a, b) => {
    const ta = pickSortTimestamp(a.data() as DocData);
    const tb = pickSortTimestamp(b.data() as DocData);
    return ta - tb;
  });

  logger.info({ collection: name, count: docs.length }, "starting sticker id migration");

  for (const doc of docs) {
    stats.scanned++;
    const data = doc.data() as DocData;
    const fileId = typeof data.file_id === "string" ? data.file_id : "";
    const existingUniqueId = typeof data.file_unique_id === "string" ? data.file_unique_id : "";

    if (!fileId) {
      logger.warn({ collection: name, docId: doc.id }, "missing file_id, skipping");
      stats.skipped++;
      continue;
    }

    const uniqueId = existingUniqueId || (await resolveUniqueId(fileId));
    if (!uniqueId) {
      logger.warn({ collection: name, docId: doc.id, fileId }, "unable to resolve file_unique_id");
      stats.failed++;
      continue;
    }

    try {
      const targetRef = db.collection(name).doc(uniqueId);
      await targetRef.set(
        {
          ...data,
          file_id: fileId,
          file_unique_id: uniqueId,
        },
        { merge: true },
      );

      if (doc.id !== uniqueId) {
        await doc.ref.delete();
        stats.deletedOld++;
      }

      stats.migrated++;
    } catch (err) {
      logger.error(
        { err, collection: name, docId: doc.id, fileId, uniqueId },
        "migration write failed",
      );
      stats.failed++;
    }
  }

  logger.info({ collection: name, ...stats }, "sticker id migration done");
  return stats;
}

async function main(): Promise<void> {
  const stickers = await migrateCollection("stickers");
  const received = await migrateCollection("received_stickers");

  const totalFailed = stickers.failed + received.failed;
  logger.info(
    {
      stickers,
      received,
      totalFailed,
    },
    "all sticker id migrations complete",
  );

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "sticker id migration crashed");
  process.exit(1);
});
