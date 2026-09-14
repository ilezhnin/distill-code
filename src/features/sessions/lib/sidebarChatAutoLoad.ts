/**
 * The sidebar loads further chat pages on its own until it has enough rows.
 * Each cursor is attempted once, so a page that never arrives used to leave
 * the sidebar short for the rest of the run — the effect only retries when the
 * cursor advances, and a failed page does not advance it.
 *
 * The session store logs and swallows a failed page, so the only signal
 * available here is that nothing arrived. These helpers decide that, and how
 * long to wait before trying the same cursor again.
 */

/** How many times one cursor is retried before the sidebar gives up. */
export const MAX_CHAT_AUTO_LOAD_RETRIES = 3;
/** First retry delay; each further attempt doubles it. */
export const CHAT_AUTO_LOAD_RETRY_BASE_MS = 1_000;

/** Stable key for a page cursor, including the very first (null) page. */
export function chatAutoLoadCursorKey(cursor: string | null): string {
  return cursor ?? "__initial__";
}

/**
 * Whether a load-more attempt brought a page in: either the cursor moved on,
 * or the backend said there is nothing left to load.
 */
export function chatAutoLoadPageLanded({
  cursorKeyBefore,
  cursorKeyAfter,
  hasMoreSessions,
}: {
  cursorKeyBefore: string;
  cursorKeyAfter: string;
  hasMoreSessions: boolean;
}): boolean {
  return !hasMoreSessions || cursorKeyAfter !== cursorKeyBefore;
}

/**
 * Delay before retrying a cursor after `attempt` consecutive failures
 * (1-based), or `null` once the retries are used up.
 */
export function chatAutoLoadRetryDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt > MAX_CHAT_AUTO_LOAD_RETRIES) return null;
  return CHAT_AUTO_LOAD_RETRY_BASE_MS * 2 ** (attempt - 1);
}
