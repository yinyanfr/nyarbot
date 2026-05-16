import config from "../configs/env.js";
import { logger } from "./logger.js";

/**
 * Download a Telegram file by `file_path` and return a base64 data URL.
 * The bot token is used only for this fetch and **never** appears in prompts or logs.
 *
 * Returns null on failure (network error, non-2xx response, oversized payload).
 */
export async function downloadTelegramFileAsDataUrl(filePath: string): Promise<string | null> {
  const url = `https://api.telegram.org/file/bot${config.botApiKey}/${filePath}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.warn({ status: res.status, filePath }, "telegram file download non-2xx");
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    // DeepSeek / OpenAI vision have multi-MB limits; Telegram photos are typically < 2MB after compression.
    const MAX_BYTES = 10 * 1024 * 1024;
    if (buf.length > MAX_BYTES) {
      logger.warn({ bytes: buf.length, filePath }, "telegram file too large for vision");
      return null;
    }
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch (err) {
    logger.warn({ err, filePath }, "telegram file download failed");
    return null;
  }
}
