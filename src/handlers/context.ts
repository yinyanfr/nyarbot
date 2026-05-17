import type { Context } from "grammy";
import type { User } from "../global.d.ts";

export type BotContext = Context;

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
  stickerEmoji: string;
  isMentioned: boolean;
  isRepliedToBot: boolean;
  /** Hint for the next AI call — e.g. "user just woke up". */
  systemHint: string | null;
}
