/**
 * Tiny LRU of recently-seen Telegram update_ids. Telegram occasionally redelivers
 * the same update (webhook→polling switchovers, brief network glitches); without
 * dedup the bot would double-reply.
 *
 * The set is bounded so memory can't grow without limit if the bot runs for days.
 */
const MAX_SEEN = 1024;
const seen = new Set<number>();
const order: number[] = [];

export function isDuplicateUpdate(updateId: number): boolean {
  if (seen.has(updateId)) return true;
  seen.add(updateId);
  order.push(updateId);
  if (order.length > MAX_SEEN) {
    const evicted = order.shift();
    if (evicted !== undefined) seen.delete(evicted);
  }
  return false;
}
