import "dotenv/config";
import { getFirestore } from "firebase-admin/firestore";
import { initFirebase } from "../services/index.js";
import { logger } from "../libs/logger.js";

const FALLBACK_COLLECTIONS = ["users", "images", "stickers", "received_stickers", "diary"];

const BATCH_LIMIT = 500;

initFirebase();
const db = getFirestore();

async function getCollectionNames(): Promise<string[]> {
  try {
    const collections = await db.listCollections();
    if (collections.length > 0) {
      const names = collections
        .map((c) => c.id)
        .filter((id) => id.endsWith("_backup"))
        .map((id) => id.replace(/_backup$/, ""));
      logger.info({ names, dynamic: true }, "found backup collections dynamically");
      return names;
    }
  } catch (err) {
    logger.warn({ err }, "listCollections failed, falling back to hardcoded list");
  }
  logger.info({ names: FALLBACK_COLLECTIONS, dynamic: false }, "using hardcoded collection list");
  return FALLBACK_COLLECTIONS;
}

async function restoreCollection(
  name: string,
): Promise<{ name: string; restored: number; failed: number }> {
  const backupName = `${name}_backup`;
  const backupSnap = await db.collection(backupName).get();
  const backupDocs = backupSnap.docs;
  if (backupDocs.length === 0) {
    logger.warn({ name }, "backup collection is empty or missing, skipping");
    return { name, restored: 0, failed: 0 };
  }

  const backupIds = new Set(backupDocs.map((d) => d.id));

  // 1. Write backup data first (overwrites existing, adds missing)
  let restored = 0;
  let failed = 0;
  for (let i = 0; i < backupDocs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = backupDocs.slice(i, i + BATCH_LIMIT);
    for (const doc of chunk) {
      batch.set(db.collection(name).doc(doc.id), doc.data());
    }
    try {
      await batch.commit();
      restored += chunk.length;
    } catch (err) {
      logger.error({ err, name, chunk: i }, "restore write batch failed");
      failed += chunk.length;
    }
  }

  // 2. Delete docs in target that don't exist in backup
  const targetSnap = await db.collection(name).get();
  const staleDocs = targetSnap.docs.filter((d) => !backupIds.has(d.id));
  if (staleDocs.length > 0) {
    let deleted = 0;
    for (let i = 0; i < staleDocs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      const chunk = staleDocs.slice(i, i + BATCH_LIMIT);
      for (const doc of chunk) {
        batch.delete(doc.ref);
      }
      try {
        await batch.commit();
        deleted += chunk.length;
      } catch (err) {
        logger.warn({ err, name, deleted }, "stale doc cleanup partial failure");
        break;
      }
    }
    if (deleted > 0) {
      logger.info({ name, deleted }, "cleaned up stale documents");
    }
  }

  return { name, restored, failed };
}

async function main(): Promise<void> {
  const collections = await getCollectionNames();
  logger.info({ count: collections.length }, "starting restore...");

  const results: { name: string; restored: number; failed: number }[] = [];
  for (const name of collections) {
    logger.info({ name }, "restoring collection...");
    const result = await restoreCollection(name);
    logger.info(
      { name, restored: result.restored, failed: result.failed },
      "collection restore done",
    );
    results.push(result);
  }

  const totalRestored = results.reduce((s, r) => s + r.restored, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  logger.info(
    { collections: results.map((r) => r.name), totalRestored, totalFailed },
    "restore complete",
  );
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "restore failed");
  process.exit(1);
});
