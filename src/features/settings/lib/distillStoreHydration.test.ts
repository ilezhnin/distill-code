import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPersistHealthy,
  persistReadOutageScopes,
  resetPersistHealthForTests,
} from "@/features/conductor/persistHealth";

import {
  CONDUCTOR_HYDRATION_ATTEMPTS,
  CONDUCTOR_HYDRATION_RETRY_DELAYS_MS,
  flushDistillStores,
  hydrateDistillStores,
  resetDistillHydrationForTests,
  retryConductorDocumentHydration,
  setDistillHydrationDelayForTests,
} from "./distillStoreHydration";

const mocks = vi.hoisted(() => ({
  hydrateMemoryStore: vi.fn(),
  hydrateReviewSeenStore: vi.fn(),
  flushMemoryWrites: vi.fn(),
  flushReviewSeenWrites: vi.fn(),
  hydrateConductorGraph: vi.fn(),
  markConductorGraphHydrationFailed: vi.fn(),
  hasConductorGraphHydrationFailed: vi.fn(() => false),
  flushConductorGraphWrites: vi.fn(),
  hydrateWaveEngineState: vi.fn(),
  markWaveEngineStateHydrationFailed: vi.fn(),
  hasWaveEngineStateHydrationFailed: vi.fn(() => false),
  flushWaveEngineWrites: vi.fn(),
  hydrateWaveTelemetry: vi.fn(),
  markWaveTelemetryHydrationFailed: vi.fn(),
  hasWaveTelemetryHydrationFailed: vi.fn(() => false),
  flushWaveTelemetryWrites: vi.fn(),
}));

vi.mock("@/features/memory/stores/memoryStore", () => ({
  hydrateMemoryStore: mocks.hydrateMemoryStore,
  flushMemoryWrites: mocks.flushMemoryWrites,
}));
vi.mock("@/features/review/stores/reviewSeenStore", () => ({
  hydrateReviewSeenStore: mocks.hydrateReviewSeenStore,
  flushReviewSeenWrites: mocks.flushReviewSeenWrites,
}));
vi.mock("@/features/conductor/conductorGraphStore", () => ({
  hydrateConductorGraph: mocks.hydrateConductorGraph,
  markConductorGraphHydrationFailed: mocks.markConductorGraphHydrationFailed,
  hasConductorGraphHydrationFailed: mocks.hasConductorGraphHydrationFailed,
  flushConductorGraphWrites: mocks.flushConductorGraphWrites,
}));
vi.mock("@/features/conductor/waveStore", () => ({
  hydrateWaveEngineState: mocks.hydrateWaveEngineState,
  markWaveEngineStateHydrationFailed: mocks.markWaveEngineStateHydrationFailed,
  hasWaveEngineStateHydrationFailed: mocks.hasWaveEngineStateHydrationFailed,
  flushWaveEngineWrites: mocks.flushWaveEngineWrites,
}));
vi.mock("@/features/conductor/waveTelemetryStore", () => ({
  hydrateWaveTelemetry: mocks.hydrateWaveTelemetry,
  markWaveTelemetryHydrationFailed: mocks.markWaveTelemetryHydrationFailed,
  hasWaveTelemetryHydrationFailed: mocks.hasWaveTelemetryHydrationFailed,
  flushWaveTelemetryWrites: mocks.flushWaveTelemetryWrites,
}));

function flushCallCounts(): number[] {
  return [
    mocks.flushMemoryWrites.mock.calls.length,
    mocks.flushReviewSeenWrites.mock.calls.length,
  ];
}

function resetMocks(): void {
  vi.clearAllMocks();
  resetPersistHealthForTests();
  for (const failed of [
    mocks.hasConductorGraphHydrationFailed,
    mocks.hasWaveEngineStateHydrationFailed,
    mocks.hasWaveTelemetryHydrationFailed,
  ]) {
    failed.mockReturnValue(false);
  }
  for (const hydrate of [
    mocks.hydrateMemoryStore,
    mocks.hydrateReviewSeenStore,
    mocks.hydrateConductorGraph,
    mocks.hydrateWaveEngineState,
    mocks.hydrateWaveTelemetry,
  ]) {
    hydrate.mockResolvedValue(undefined);
  }
  for (const flush of [
    mocks.flushMemoryWrites,
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

  it("lets the operator re-read a document the startup read gave up on", async () => {
    // The usual cause is a file held for a few seconds at launch; by the time
    // anyone sees the notice it is readable again, and the alternative to this
    // was restarting the app.
    mocks.hydrateConductorGraph.mockRejectedValue(
      new Error("sharing violation"),
    );

    await hydrateDistillStores();
    expect(persistReadOutageScopes()).toEqual(["graph"]);
    mocks.hasConductorGraphHydrationFailed.mockReturnValue(true);

    // Still unreadable: the outage stands and the retry reports failure.
    expect(await retryConductorDocumentHydration()).toBe(false);
    expect(persistReadOutageScopes()).toEqual(["graph"]);

    mocks.hydrateConductorGraph.mockResolvedValue(undefined);
    expect(await retryConductorDocumentHydration()).toBe(true);
    expect(persistReadOutageScopes()).toEqual([]);
    expect(isPersistHealthy()).toBe(true);
    // One attempt per press — the operator is the retry loop now.
    expect(mocks.hydrateConductorGraph).toHaveBeenCalledTimes(
      CONDUCTOR_HYDRATION_ATTEMPTS + 2,
    );
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

  it("keeps flushing the rest when one store's flush rejects", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.flushMemoryWrites.mockRejectedValueOnce(new Error("disk gone"));

    flushDistillStores();

    expect(flushCallCounts()).toEqual([1, 1]);
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
    expect(flushCallCounts()).toEqual([1, 1]);
  });
});
