import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  flushDistillStores,
  hydrateDistillStores,
  resetDistillHydrationForTests,
} from "./distillStoreHydration";

const mocks = vi.hoisted(() => ({
  hydrateMemoryStore: vi.fn(),
  hydratePlannerStore: vi.fn(),
  hydrateReviewSeenStore: vi.fn(),
  flushMemoryWrites: vi.fn(),
  flushPlannerWrites: vi.fn(),
  flushReviewSeenWrites: vi.fn(),
}));

vi.mock("@/features/memory/stores/memoryStore", () => ({
  hydrateMemoryStore: mocks.hydrateMemoryStore,
  flushMemoryWrites: mocks.flushMemoryWrites,
}));
vi.mock("@/features/planner/stores/plannerStore", () => ({
  hydratePlannerStore: mocks.hydratePlannerStore,
  flushPlannerWrites: mocks.flushPlannerWrites,
}));
vi.mock("@/features/review/stores/reviewSeenStore", () => ({
  hydrateReviewSeenStore: mocks.hydrateReviewSeenStore,
  flushReviewSeenWrites: mocks.flushReviewSeenWrites,
}));

function flushCallCounts(): number[] {
  return [
    mocks.flushPlannerWrites.mock.calls.length,
    mocks.flushMemoryWrites.mock.calls.length,
    mocks.flushReviewSeenWrites.mock.calls.length,
  ];
}

/** The teardown signal the main window's close-as-hide produces. */
function dispatchVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("distill store shutdown flush", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const hydrate of [
      mocks.hydrateMemoryStore,
      mocks.hydratePlannerStore,
      mocks.hydrateReviewSeenStore,
    ]) {
      hydrate.mockResolvedValue(undefined);
    }
    for (const flush of [
      mocks.flushMemoryWrites,
      mocks.flushPlannerWrites,
      mocks.flushReviewSeenWrites,
    ]) {
      flush.mockResolvedValue(undefined);
    }
    resetDistillHydrationForTests();
    // The close-flush hooks are installed by the first hydration in this test
    // file and stay on window/document for the rest of it — exactly the
    // per-window once-only behavior the app relies on.
    await hydrateDistillStores();
  });

  it("flushes every store's queued write", () => {
    flushDistillStores();
    expect(flushCallCounts()).toEqual([1, 1, 1]);
  });

  it("keeps flushing the rest when one store's flush rejects", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.flushPlannerWrites.mockRejectedValueOnce(new Error("disk gone"));

    flushDistillStores();

    expect(flushCallCounts()).toEqual([1, 1, 1]);
    // The rejection surfaces as a diagnostic on the microtask queue, never as
    // an exception into the teardown path.
    return vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to flush a Distill document:",
        expect.any(Error),
      );
    });
  });

  it("flushes on a real unload", () => {
    const before = flushCallCounts();
    window.dispatchEvent(new Event("pagehide"));
    expect(flushCallCounts()).toEqual(before.map((count) => count + 1));
  });

  it("flushes when the window is hidden, and only then", () => {
    const before = flushCallCounts();

    dispatchVisibility("hidden");
    expect(flushCallCounts()).toEqual(before.map((count) => count + 1));

    const afterHidden = flushCallCounts();
    dispatchVisibility("visible");
    expect(flushCallCounts()).toEqual(afterHidden);
  });

  it("installs the listeners once, however often hydration is re-run", async () => {
    const addWindowListener = vi.spyOn(window, "addEventListener");

    resetDistillHydrationForTests();
    await hydrateDistillStores();
    resetDistillHydrationForTests();
    await hydrateDistillStores();

    expect(
      addWindowListener.mock.calls.filter(([type]) => type === "pagehide"),
    ).toHaveLength(0);

    // One registration from the first hydration: one teardown event, one
    // flush of each store, not one per re-hydration.
    window.dispatchEvent(new Event("pagehide"));
    expect(flushCallCounts()).toEqual([1, 1, 1]);
  });
});
