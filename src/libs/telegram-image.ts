import config from "../configs/env.js";
import { logger } from "./logger.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { Readable } from "node:stream";

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

/**
 * Download a Telegram sticker by `file_id` and return a base64 data URL.
 * First calls getFile to resolve the file_path, then downloads the file.
 * Works without a grammy ctx object — uses raw Telegram Bot API.
 */
export async function downloadTelegramStickerAsDataUrl(fileId: string): Promise<string | null> {
  try {
    const getFileUrl = `https://api.telegram.org/bot${config.botApiKey}/getFile?file_id=${fileId}`;
    const fileRes = await fetch(getFileUrl, { signal: AbortSignal.timeout(10_000) });
    if (!fileRes.ok) return null;
    const data = (await fileRes.json()) as { result?: { file_path?: string } };
    if (!data.result?.file_path) return null;
    return downloadTelegramFileAsDataUrl(data.result.file_path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sticker format conversion for Gemini compatibility
// ---------------------------------------------------------------------------
// Telegram stickers are webp (static) or webm (animated).
// Static webp stickers can be passed directly to Gemini.
// Animated webm stickers need first-frame extraction → webp via fluent-ffmpeg
// backed by a bundled ffmpeg binary (ffmpeg-static).
// No PNG/JPEG conversion — webp works natively with Gemini via Cloudflare AI Gateway.

const ffmpegBin = ffmpegPath as unknown as string | null;
logger.info({ path: ffmpegBin }, "ffmpeg-static path");
if (ffmpegBin) {
  ffmpeg.setFfmpegPath(ffmpegBin);
}

async function extractWebmFirstFrame(input: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const chunks: Buffer[] = [];
      const stream = Readable.from(input);
      const ff = ffmpeg()
        .input(stream)
        .inputFormat("webm")
        .seek("00:00:00")
        .frames(1)
        .outputFormat("webp")
        .noAudio();

      ff.on("error", (err: Error) => {
        logger.warn({ err }, "webm first-frame extraction failed");
        resolve(null);
      });
      ff.on("stderr", (line: string) => {
        logger.debug({ line }, "ffmpeg stderr");
      });

      const cmd = ff.pipe();
      cmd.on("data", (chunk: Buffer) => chunks.push(chunk));
      cmd.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 0 ? buf : null);
      });
    } catch (err) {
      logger.warn({ err }, "webm first-frame extraction crashed");
      resolve(null);
    }
  });
}

/**
 * Convert a sticker data URL to a webp data URL suitable for Gemini input.
 * - image/webp → passed through as-is (no conversion needed)
 * - video/webm → first-frame webp (via fluent-ffmpeg)
 * - application/octet-stream → detected by file signature, then converted
 * - Other formats returned as-is.
 * On conversion failure, returns the original data URL as fallback.
 */
export async function convertStickerForGemini(dataUrl: string): Promise<string> {
  const mimeMatch = dataUrl.match(/^data:([^;]+)/);
  const mime = mimeMatch?.[1] ?? "";
  const base64 = dataUrl.split(",")[1];
  if (!base64) return dataUrl;

  try {
    if (mime === "video/webm") {
      const buf = Buffer.from(base64, "base64");
      const webpBuf = await extractWebmFirstFrame(buf);
      if (webpBuf && webpBuf.length > 0) {
        return `data:image/webp;base64,${webpBuf.toString("base64")}`;
      }
      logger.warn({ mime }, "webm conversion failed, returning empty");
      return "";
    }

    if (mime === "application/octet-stream") {
      const buf = Buffer.from(base64, "base64");
      // Detect WebM by EBML signature (0x1A 0x45 0xDF 0xA3)
      if (
        buf.length >= 4 &&
        buf[0] === 0x1a &&
        buf[1] === 0x45 &&
        buf[2] === 0xdf &&
        buf[3] === 0xa3
      ) {
        const webpBuf = await extractWebmFirstFrame(buf);
        if (webpBuf && webpBuf.length > 0) {
          return `data:image/webp;base64,${webpBuf.toString("base64")}`;
        }
        logger.warn({ mime }, "application/octet-stream webm conversion failed, returning empty");
        return "";
      }
      // Detect WebP by RIFF....WEBP signature
      if (
        buf.length >= 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
      ) {
        return `data:image/webp;base64,${buf.toString("base64")}`;
      }
      logger.warn({ mime }, "unknown application/octet-stream, returning empty");
      return "";
    }
  } catch (err) {
    logger.warn({ err, mime }, "sticker format conversion failed, returning empty");
    return "";
  }

  return dataUrl;
}
