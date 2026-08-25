import { beforeEach, describe, expect, it } from "vitest";

import {
  flushReviewSeenWrites,
  parseLastSeenAt,
  REVIEW_SEEN_STORAGE_KEY,
  useReviewSeenStore,
} from "./reviewSeenStore";

describe("useReviewSeenStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useReviewSeenStore.getState().reset(0);
  });

  it("remembers when the operator last read the queue", async () => {
    useReviewSeenStore.getState().markSeen(5_000);
    await flushReviewSeenWrites();

    expect(useReviewSeenStore.getState().lastSeenAt).toBe(5_000);
    expect(
      parseLastSeenAt(
        JSON.parse(
          window.localStorage.getItem(REVIEW_SEEN_STORAGE_KEY) ?? "{}",
        ),
      ),
    ).toBe(5_000);
  });
});

describe("parseLastSeenAt", () => {
  it("reads the stored shape and a bare number", () => {
    expect(parseLastSeenAt({ lastSeenAt: 42 })).toBe(42);
    expect(parseLastSeenAt(42)).toBe(42);
  });

  it("treats anything unreadable as never read", () => {
    // Never-read shows everything, which is the safe direction: the other
    // way round would hide finished work behind a bad stored value.
    expect(parseLastSeenAt(null)).toBe(0);
    expect(parseLastSeenAt({ lastSeenAt: "yesterday" })).toBe(0);
    expect(parseLastSeenAt(Number.NaN)).toBe(0);
    expect(parseLastSeenAt(-1)).toBe(0);
  });
});
