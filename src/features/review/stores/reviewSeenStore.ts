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
 *
 * The first run is the exception, and it has to be. "While you were away"
 * means "since you last looked", and before the first look there is no such
 * moment — reading zero would announce every run the graph still remembers,
 * including the ones the operator watched finish themselves. So an unwritten
 * document is seeded with the current time: the queue starts empty and fills
 * with what happens next, which is the only thing it can honestly be about.
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
    // The far future until the read lands: for the fraction of a second
    // before hydration, showing nothing beats flashing a list that is about
    // to be replaced.
    lastSeenAt: Number.POSITIVE_INFINITY,

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

/**
 * Fills the store from disk, seeding the first run with "now".
 *
 * `nowMs` is an argument so the seeding can be tested without the clock.
 */
export async function hydrateReviewSeenStore(
  nowMs: number = Date.now(),
): Promise<void> {
  const stored = await document.read();
  if (stored !== null) {
    useReviewSeenStore.setState({ lastSeenAt: stored });
    return;
  }
  // Recorded, not just held: a first run that ended without the operator
  // pressing anything must not announce the same history on the next start.
  useReviewSeenStore.getState().reset(nowMs);
}

/** Waits for a queued write to land. For tests and for shutdown. */
export function flushReviewSeenWrites(): Promise<void> {
  return document.flush();
}
