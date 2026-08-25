import { beforeEach, describe, expect, it } from "vitest";

import {
  flushReviewSeenWrites,
  hydrateReviewSeenStore,
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

describe("hydrateReviewSeenStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useReviewSeenStore.getState().reset(0);
  });

  it("seeds the first run with now, so the queue starts empty", async () => {
    // "While you were away" has no meaning before the first look. Reading
    // zero would announce every run the graph still remembers, including the
    // ones the operator watched finish themselves.
    window.localStorage.clear();

    await hydrateReviewSeenStore(9_000);

    expect(useReviewSeenStore.getState().lastSeenAt).toBe(9_000);
  });

  it("records that seed, so the next start does not announce it all again", async () => {
    window.localStorage.clear();
    await hydrateReviewSeenStore(9_000);
    await flushReviewSeenWrites();

    expect(
      parseLastSeenAt(
        JSON.parse(
          window.localStorage.getItem(REVIEW_SEEN_STORAGE_KEY) ?? "{}",
        ),
      ),
    ).toBe(9_000);
  });

  it("keeps a stored value instead of reseeding it", async () => {
    useReviewSeenStore.getState().reset(1_234);
    await flushReviewSeenWrites();

    await hydrateReviewSeenStore(9_000);

    expect(useReviewSeenStore.getState().lastSeenAt).toBe(1_234);
  });
});

describe("parseLastSeenAt", () => {
  it("reads the stored shape and a bare number", () => {
    expect(parseLastSeenAt({ lastSeenAt: 42 })).toBe(42);
    expect(parseLastSeenAt(42)).toBe(42);
  });

  it("treats anything unreadable as never read", () => {
    // Never-read is the seeding case, which starts the queue empty rather
    // than replaying history behind a bad stored value.
    expect(parseLastSeenAt(null)).toBe(0);
    expect(parseLastSeenAt({ lastSeenAt: "yesterday" })).toBe(0);
    expect(parseLastSeenAt(Number.NaN)).toBe(0);
    expect(parseLastSeenAt(-1)).toBe(0);
  });
});
