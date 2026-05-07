import admin, { type ServiceAccount } from "firebase-admin";
import { readFileSync } from "node:fs";
import { logger } from "../libs/logger.js";

export function initFirebase(): void {
  try {
    const path = new URL("./serviceAccountKey.json", import.meta.url);
    const serviceAccount = JSON.parse(readFileSync(path, "utf-8"));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as ServiceAccount),
    });
    logger.info("firebase initialized");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        "Firebase service account file not found at src/services/serviceAccountKey.json. " +
          "Create it from the Firebase Console or set GOOGLE_APPLICATION_CREDENTIALS env var.",
      );
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        "Firebase service account file contains invalid JSON. " +
          "Re-download it from the Firebase Console.",
      );
    }
    throw err;
  }
}
