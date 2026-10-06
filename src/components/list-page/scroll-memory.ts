/**
 * scroll-memory.ts — the app's in-memory, per-key scroll offsets.
 *
 * NO persistence, NO URL/session state: a plain module map that survives
 * route navigation (the SPA never reloads) and remembers where the user
 * was in each visited page's scroller, so
 *
 *     list → detail → Back → list
 *
 * returns to the exact browsing position — including scroll-to-load lists
 * whose cached batches re-render synchronously. Offsets are consumed on
 * restore (a later fresh visit starts at the top, never replays an old
 * position) and the map is capped so it can never grow unbounded.
 *
 * ONE policy shared by the shell's <main> scroller (every normal page)
 * and the list pages' table viewports.
 */

/** Upper bound on remembered pages (oldest evicted first). */
const MAX_ENTRIES = 60;

const memory = new Map<string, number>();

/** Remember a scroller's offset under a key (overwrites any previous). */
export function rememberScroll(key: string, offset: number): void {
  memory.set(key, Math.max(0, Math.round(offset)));
  if (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (typeof oldest === 'string') memory.delete(oldest);
  }
}

/**
 * Take the remembered offset for a key (removing it) — null when the key
 * was never saved. Restore paths consume so the same position is never
 * restored twice.
 */
export function consumeScroll(key: string): number | null {
  const offset = memory.get(key);
  if (offset === undefined) return null;
  memory.delete(key);
  return offset;
}
