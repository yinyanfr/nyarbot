import config from "../configs/env.js";
import { logger } from "./logger.js";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;

async function readLocalImage(filePath: string, directory: string, token: string): Promise<Buffer> {
  // Limit access to this bot's subtree, including after resolving symlinks.
  const root = await realpath(`${directory}/${token}`);
  const path = await realpath(filePath);
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Local Telegram file is outside the bot directory");
  }
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES)
      throw new Error("Invalid or oversized Telegram image");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

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
  apiRoot?: string;
  localFileDirectory?: string;
}

export function createTelegramImageDownloader(
  dependencies: TelegramImageDependencies,
): (filePath: string) => Promise<string | null> {
  return async (filePath: string): Promise<string | null> => {
    try {
      let buf: Buffer;
      let responseContentType: string | undefined;
      if (isAbsolute(filePath)) {
        if (!dependencies.localFileDirectory) return null;
        buf = await readLocalImage(
          filePath,
          dependencies.localFileDirectory,
          dependencies.botApiKey,
        );
      } else {
        // getFile normally returns a relative path; reject traversal/URL components.
        if (
          !/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(filePath) &&
          !/^[a-zA-Z0-9_/-]+$/.test(filePath)
        )
          return null;
        const url = `${(dependencies.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "")}/file/bot${dependencies.botApiKey}/${filePath}`;
        const res = await dependencies.fetch(url, { signal: dependencies.timeout(15_000) });
        if (!res.ok) {
          logger.warn({ status: res.status }, "telegram file download non-2xx");
          return null;
        }
        buf = Buffer.from(await res.arrayBuffer());
        responseContentType = res.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
      }
      // DeepSeek / OpenAI vision have multi-MB limits; Telegram photos are typically < 2MB after compression.
      if (buf.length > MAX_BYTES) {
        logger.warn({ bytes: buf.length }, "telegram file too large for vision");
        return null;
      }
      const detectedContentType = detectImageContentType(buf);
      const contentType =
        detectedContentType ??
        (isSupportedImageContentType(responseContentType) ? responseContentType : null);
      if (!contentType) {
        logger.warn(
          { responseContentType: responseContentType ?? null },
          "telegram file is not a supported image",
        );
        return null;
      }
      return `data:${contentType};base64,${buf.toString("base64")}`;
    } catch {
      // Local paths and fetch errors can contain the bot token. Never log them.
      logger.warn("telegram file download failed");
      return null;
    }
  };
}

export const downloadTelegramFileAsDataUrl = createTelegramImageDownloader({
  fetch: globalThis.fetch,
  timeout: AbortSignal.timeout,
  botApiKey: config.botApiKey,
  apiRoot: config.telegramApiRoot,
  localFileDirectory: config.telegramLocalFileDirectory,
});
