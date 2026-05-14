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
      const names = collections.map((c) => c.id).filter((id) => !id.endsWith("_backup"));
      logger.info({ names, dynamic: true }, "found collections dynamically");
      return names;
    }
  } catch (err) {
    logger.warn({ err }, "listCollections failed, falling back to hardcoded list");
  }
  logger.info({ names: FALLBACK_COLLECTIONS, dynamic: false }, "using hardcoded collection list");
  return FALLBACK_COLLECTIONS;
}

async function backupCollection(
  name: string,
): Promise<{ name: string; backedUp: number; failed: number }> {
  const backupName = `${name}_backup`;
  const sourceSnap = await db.collection(name).get();
  const docs = sourceSnap.docs;
  if (docs.length === 0) {
    logger.info({ name }, "collection is empty, clearing backup and skipping");
    const existingSnap = await db.collection(backupName).get();
    if (existingSnap.docs.length > 0) {
      for (let i = 0; i < existingSnap.docs.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        const chunk = existingSnap.docs.slice(i, i + BATCH_LIMIT);
        for (const doc of chunk) batch.delete(doc.ref);
        await batch.commit();
      }
    }
    return { name, backedUp: 0, failed: 0 };
  }

  // Clear previous backup to keep it a true snapshot
  const existingSnap = await db.collection(backupName).get();
  if (existingSnap.docs.length > 0) {
    for (let i = 0; i < existingSnap.docs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      const chunk = existingSnap.docs.slice(i, i + BATCH_LIMIT);
      for (const doc of chunk) batch.delete(doc.ref);
      await batch.commit();
    }
  }

  let backedUp = 0;
  let failed = 0;

  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + BATCH_LIMIT);
    for (const doc of chunk) {
      const ref = db.collection(backupName).doc(doc.id);
      batch.set(ref, doc.data());
    }
    try {
      await batch.commit();
      backedUp += chunk.length;
    } catch (err) {
      logger.error({ err, name, chunk: i }, "backup batch commit failed");
      failed += chunk.length;
    }
  }

  return { name, backedUp, failed };
}

async function main(): Promise<void> {
  const collections = await getCollectionNames();
  logger.info({ count: collections.length }, "starting backup...");

  const results: { name: string; backedUp: number; failed: number }[] = [];
  for (const name of collections) {
    logger.info({ name }, "backing up collection...");
    const result = await backupCollection(name);
    logger.info(
      { name, backedUp: result.backedUp, failed: result.failed },
      "collection backup done",
    );
    results.push(result);
  }

  const totalBackedUp = results.reduce((s, r) => s + r.backedUp, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  logger.info(
    { collections: results.map((r) => r.name), totalBackedUp, totalFailed },
    "backup complete",
  );
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "backup failed");
  process.exit(1);
});
