import config from "../configs/env.js";
import { logger } from "./logger.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  if (hasBytesAt(buffer, 0, [0x42, 0x4d])) return "image/bmp";
  if (
    hasBytesAt(buffer, 0, [0x49, 0x49, 0x2a, 0x00]) ||
    hasBytesAt(buffer, 0, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image/tiff";
  }
  if (hasBytesAt(buffer, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }
  return null;
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

export interface TelegramVideoDependencies extends TelegramImageDependencies {
  spawn: typeof spawn;
  mkdtemp: (prefix: string) => Promise<string>;
  readFile: (filePath: string) => Promise<Buffer>;
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
  rm: (targetPath: string, options: { recursive: true; force: true }) => Promise<unknown>;
  tmpdir: () => string;
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
      // Qwen Base64 vision input is capped; Telegram photos are typically < 2MB after compression.
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
        (responseContentType?.startsWith("image/") ? responseContentType : null);
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

function isWebm(buffer: Buffer): boolean {
  return hasBytesAt(buffer, 0, [0x1a, 0x45, 0xdf, 0xa3]);
}

async function convertWebmStickerForVision(
  input: Buffer,
  dependencies: Pick<
    TelegramVideoDependencies,
    "spawn" | "mkdtemp" | "readFile" | "writeFile" | "rm" | "tmpdir"
  >,
): Promise<Buffer | null> {
  const directory = await dependencies.mkdtemp(
    path.join(dependencies.tmpdir(), "nyarbot-sticker-"),
  );
  const inputPath = path.join(directory, "sticker.webm");
  const outputPath = path.join(directory, "sticker.mp4");
  try {
    await dependencies.writeFile(inputPath, input);
    const succeeded = await new Promise<boolean>((resolve) => {
      const child = dependencies.spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-stream_loop",
          "-1",
          "-i",
          inputPath,
          "-t",
          "2.1",
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-y",
          outputPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(false);
      }, 15_000);
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      child.stderr?.resume();
    });
    if (!succeeded) return null;
    const output = await dependencies.readFile(outputPath);
    return output.length > 0 && output.length <= 7 * 1024 * 1024 ? output : null;
  } finally {
    await dependencies.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createTelegramVideoStickerDownloader(
  dependencies: TelegramVideoDependencies,
): (filePath: string) => Promise<string | null> {
  return async (filePath: string): Promise<string | null> => {
    const url = `https://api.telegram.org/file/bot${dependencies.botApiKey}/${filePath}`;
    try {
      const res = await dependencies.fetch(url, { signal: dependencies.timeout(15_000) });
      if (!res.ok) return null;
      const webm = Buffer.from(await res.arrayBuffer());
      if (webm.length > 5 * 1024 * 1024 || !isWebm(webm)) return null;
      const mp4 = await convertWebmStickerForVision(webm, dependencies);
      return mp4 ? `data:video/mp4;base64,${mp4.toString("base64")}` : null;
    } catch (err) {
      logger.warn({ err, filePath }, "telegram video sticker conversion failed");
      return null;
    }
  };
}

export const downloadTelegramVideoStickerAsDataUrl = createTelegramVideoStickerDownloader({
  fetch: globalThis.fetch,
  timeout: AbortSignal.timeout,
  botApiKey: config.botApiKey,
  spawn,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  tmpdir,
});
