import type { Context } from "grammy";
import type { StreamFlavor } from "@grammyjs/stream";
import type { User } from "../global.d.ts";

export type BotContext = StreamFlavor<Context>;

export interface BotInfo {
  id: number;
  username: string;
}

/**
 * Per-update state carried through the middleware chain.
 * Populated by early middlewares, consumed by later ones.
 */
export interface RequestState {
  user: User;
  displayName: string;
  rawText: string;
  entities: { type: string; offset: number; length: number }[];
  urls: string[];
  photoFileIds: string[];
  /** Downloaded image data URLs for vision input — never contains bot token. */
  imageDataUrls: string[];
  /** Cached image descriptions (text, no URLs). */
  imageDescriptions: string[];
  stickerEmoji: string;
  /** Pending URL-content extraction, resolves to map<url, summary|null>. */
  urlFetchPromise: Promise<Map<string, string | null>>;
  isMentioned: boolean;
  isRepliedToBot: boolean;
  /** Hint for the next AI call — e.g. "user just woke up". */
  systemHint: string | null;
}
