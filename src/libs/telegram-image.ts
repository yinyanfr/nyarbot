import config from "../configs/env.js";
import { logger } from "./logger.js";

function hasBytesAt(buffer: Buffer, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => buffer[offset + index] === byte);
}

function detectImageContentType(buffer: Buffer): string | null {
  if (hasBytesAt(buffer, 0, [0xff, 0xd8])) return "image/jpeg";
  if (hasBytesAt(buffer, 0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (hasBytesAt(buffer, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    hasBytesAt(buffer, 0, [0x52, 0x49, 0x46, 0x46]) &&
    hasBytesAt(buffer, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return null;
}

function isSupportedImageContentType(contentType: string | undefined): contentType is string {
  return /^(?:image\/jpeg|image\/png|image\/gif|image\/webp)$/.test(contentType ?? "");
}

/**
 * Download a Telegram file by `file_path` and return a base64 data URL.
 * The bot token is used only for this fetch and **never** appears in prompts or logs.
 *
 * Returns null on failure (network error, non-2xx response, oversized payload).
 */
export interface TelegramImageDependencies {
  fetch: typeof fetch;
  timeout: (milliseconds: number) => AbortSignal;
  botApiKey: string;
}

export function createTelegramImageDownloader(
  dependencies: TelegramImageDependencies,
): (filePath: string) => Promise<string | null> {
  return async (filePath: string): Promise<string | null> => {
    const url = `https://api.telegram.org/file/bot${dependencies.botApiKey}/${filePath}`;

    try {
      const res = await dependencies.fetch(url, { signal: dependencies.timeout(15_000) });
      if (!res.ok) {
        logger.warn({ status: res.status, filePath }, "telegram file download non-2xx");
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // DeepSeek / OpenAI vision have multi-MB limits; Telegram photos are typically < 2MB after compression.
      const MAX_BYTES = 10 * 1024 * 1024;
      if (buf.length > MAX_BYTES) {
        logger.warn({ bytes: buf.length, filePath }, "telegram file too large for vision");
        return null;
      }
      const detectedContentType = detectImageContentType(buf);
      const responseContentType = res.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const contentType =
        detectedContentType ??
        (isSupportedImageContentType(responseContentType) ? responseContentType : null);
      if (!contentType) {
        logger.warn(
          { responseContentType: responseContentType ?? null, filePath },
          "telegram file is not a supported image",
        );
        return null;
      }
      return `data:${contentType};base64,${buf.toString("base64")}`;
    } catch (err) {
      logger.warn({ err, filePath }, "telegram file download failed");
      return null;
    }
  };
}

export const downloadTelegramFileAsDataUrl = createTelegramImageDownloader({
  fetch: globalThis.fetch,
  timeout: AbortSignal.timeout,
  botApiKey: config.botApiKey,
});
