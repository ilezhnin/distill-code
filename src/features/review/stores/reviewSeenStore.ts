/**
 * When the operator last looked at what finished.
 *
 * One number, in a JSON document in the operator's Distill folder, for the
 * same reason the planner's list is there: it is this machine's fact about
 * this person, it must survive a reload, and nothing may break if it cannot
 * be read. An old browser copy is migrated on first read, then removed.
 *
 * Marking seen is explicit — a button — rather than automatic on render.
 * A queue that clears itself the moment the home screen paints would be
 * empty by the time someone who glanced at it in passing came back to read
 * it properly, which is exactly when it matters most.
 */

import { create } from "zustand";

import { distillDocument } from "@/shared/lib/distillDocument";

/** Path under the Distill root. */
export const REVIEW_SEEN_DOCUMENT_PATH = "review-seen.json";

/** Where this lived before the move; read once, then removed. */
export const REVIEW_SEEN_STORAGE_KEY = "goose:review-seen";

interface ReviewSeenState {
  lastSeenAt: number;
}

interface ReviewSeenActions {
  markSeen: (nowMs?: number) => void;
  /** Test seam. */
  reset: (lastSeenAt: number) => void;
}

export function parseLastSeenAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const raw = (value as { lastSeenAt?: unknown })?.lastSeenAt;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

const document = distillDocument<number>({
  path: REVIEW_SEEN_DOCUMENT_PATH,
  legacyStorageKey: REVIEW_SEEN_STORAGE_KEY,
  parse: parseLastSeenAt,
  serialize: (lastSeenAt) => ({ version: 1, lastSeenAt }),
});

export const useReviewSeenStore = create<ReviewSeenState & ReviewSeenActions>(
  (set) => ({
    // Zero until the read lands, which shows everything rather than nothing:
    // for a queue of news, over-reporting for a moment at startup is the safe
    // direction, and hiding finished work is not.
    lastSeenAt: 0,

    markSeen: (nowMs = Date.now()) => {
      document.write(nowMs);
      set({ lastSeenAt: nowMs });
    },

    reset: (lastSeenAt) => {
      document.write(lastSeenAt);
      set({ lastSeenAt });
    },
  }),
);

/** Fills the store from disk. Called once at startup. */
export async function hydrateReviewSeenStore(): Promise<void> {
  const stored = await document.read();
  if (stored !== null) useReviewSeenStore.setState({ lastSeenAt: stored });
}

/** Waits for a queued write to land. For tests and for shutdown. */
export function flushReviewSeenWrites(): Promise<void> {
  return document.flush();
}
