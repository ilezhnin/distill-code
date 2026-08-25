/**
 * When the operator last looked at what finished.
 *
 * One number, in localStorage, for the same reason the planner's list is
 * there: it is this machine's fact about this person, it must survive a
 * reload, and nothing may break if it cannot be read.
 *
 * Marking seen is explicit — a button — rather than automatic on render.
 * A queue that clears itself the moment the home screen paints would be
 * empty by the time someone who glanced at it in passing came back to read
 * it properly, which is exactly when it matters most.
 */

import { create } from "zustand";

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

function load(): number {
  try {
    const raw = window.localStorage.getItem(REVIEW_SEEN_STORAGE_KEY);
    return raw ? parseLastSeenAt(JSON.parse(raw)) : 0;
  } catch {
    return 0;
  }
}

function persist(lastSeenAt: number): void {
  try {
    window.localStorage.setItem(
      REVIEW_SEEN_STORAGE_KEY,
      JSON.stringify({ version: 1, lastSeenAt }),
    );
  } catch {
    // localStorage may be unavailable; the queue still works for this session.
  }
}

export const useReviewSeenStore = create<ReviewSeenState & ReviewSeenActions>(
  (set) => ({
    lastSeenAt: load(),

    markSeen: (nowMs = Date.now()) => {
      persist(nowMs);
      set({ lastSeenAt: nowMs });
    },

    reset: (lastSeenAt) => {
      persist(lastSeenAt);
      set({ lastSeenAt });
    },
  }),
);
