import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONDUCTOR_HYDRATION_ATTEMPTS,
  CONDUCTOR_HYDRATION_RETRY_DELAYS_MS,
  flushDistillStores,
  hydrateDistillStores,
  resetDistillHydrationForTests,
  setDistillHydrationDelayForTests,
} from "./distillStoreHydration";

const mocks = vi.hoisted(() => ({
  hydrateMemoryStore: vi.fn(),
  hydratePlannerStore: vi.fn(),
  hydrateReviewSeenStore: vi.fn(),
  flushMemoryWrites: vi.fn(),
  flushPlannerWrites: vi.fn(),
  flushReviewSeenWrites: vi.fn(),
  hydrateConductorGraph: vi.fn(),
  markConductorGraphHydrationFailed: vi.fn(),
  flushConductorGraphWrites: vi.fn(),
  hydrateWaveEngineState: vi.fn(),
  markWaveEngineStateHydrationFailed: vi.fn(),
  flushWaveEngineWrites: vi.fn(),
  hydrateWaveTelemetry: vi.fn(),
  markWaveTelemetryHydrationFailed: vi.fn(),
  flushWaveTelemetryWrites: vi.fn(),
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
vi.mock("@/features/conductor/conductorGraphStore", () => ({
  hydrateConductorGraph: mocks.hydrateConductorGraph,
  markConductorGraphHydrationFailed: mocks.markConductorGraphHydrationFailed,
  flushConductorGraphWrites: mocks.flushConductorGraphWrites,
}));
vi.mock("@/features/conductor/waveStore", () => ({
  hydrateWaveEngineState: mocks.hydrateWaveEngineState,
  markWaveEngineStateHydrationFailed: mocks.markWaveEngineStateHydrationFailed,
  flushWaveEngineWrites: mocks.flushWaveEngineWrites,
}));
vi.mock("@/features/conductor/waveTelemetryStore", () => ({
  hydrateWaveTelemetry: mocks.hydrateWaveTelemetry,
  markWaveTelemetryHydrationFailed: mocks.markWaveTelemetryHydrationFailed,
  flushWaveTelemetryWrites: mocks.flushWaveTelemetryWrites,
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

function resetMocks(): void {
  vi.clearAllMocks();
  for (const hydrate of [
    mocks.hydrateMemoryStore,
    mocks.hydratePlannerStore,
    mocks.hydrateReviewSeenStore,
    mocks.hydrateConductorGraph,
    mocks.hydrateWaveEngineState,
    mocks.hydrateWaveTelemetry,
  ]) {
    hydrate.mockResolvedValue(undefined);
  }
  for (const flush of [
    mocks.flushMemoryWrites,
    mocks.flushPlannerWrites,
    mocks.flushReviewSeenWrites,
    mocks.flushConductorGraphWrites,
    mocks.flushWaveEngineWrites,
    mocks.flushWaveTelemetryWrites,
  ]) {
    flush.mockResolvedValue(undefined);
  }
}

describe("the conductor documents are retried on a failed read", () => {
  const pauses: number[] = [];

  beforeEach(() => {
    resetMocks();
    pauses.length = 0;
    setDistillHydrationDelayForTests(async (ms) => {
      pauses.push(ms);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetDistillHydrationForTests();
  });

  afterEach(() => {
    setDistillHydrationDelayForTests(null);
  });

  it("reads again after a transient failure and never tells the store to give up", async () => {
    mocks.hydrateConductorGraph
      .mockRejectedValueOnce(new Error("sharing violation"))
      .mockResolvedValueOnce(undefined);

    await hydrateDistillStores();

    expect(mocks.hydrateConductorGraph).toHaveBeenCalledTimes(2);
    expect(pauses).toEqual([CONDUCTOR_HYDRATION_RETRY_DELAYS_MS[0]]);
    expect(mocks.markConductorGraphHydrationFailed).not.toHaveBeenCalled();
    // The other two read fine the first time and were not retried.
    expect(mocks.hydrateWaveEngineState).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateWaveTelemetry).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt, with backoff between them, and says so to the store", async () => {
    mocks.hydrateWaveEngineState.mockRejectedValue(new Error("EPERM"));

    await hydrateDistillStores();

    expect(mocks.hydrateWaveEngineState).toHaveBeenCalledTimes(
      CONDUCTOR_HYDRATION_ATTEMPTS,
    );
    expect(pauses).toEqual([...CONDUCTOR_HYDRATION_RETRY_DELAYS_MS]);
    expect(mocks.markWaveEngineStateHydrationFailed).toHaveBeenCalledTimes(1);
    // One store giving up does not touch the others.
    expect(mocks.markConductorGraphHydrationFailed).not.toHaveBeenCalled();
    expect(mocks.markWaveTelemetryHydrationFailed).not.toHaveBeenCalled();
  });

  it("retries the telemetry document the same way", async () => {
    mocks.hydrateWaveTelemetry.mockRejectedValue(new Error("EPERM"));

    await hydrateDistillStores();

    expect(mocks.hydrateWaveTelemetry).toHaveBeenCalledTimes(
      CONDUCTOR_HYDRATION_ATTEMPTS,
    );
    expect(mocks.markWaveTelemetryHydrationFailed).toHaveBeenCalledTimes(1);
  });
});

describe("distill store shutdown flush", () => {
  beforeEach(async () => {
    resetMocks();
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
