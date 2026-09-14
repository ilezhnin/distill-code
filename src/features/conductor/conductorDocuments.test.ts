import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const writeDistillDocument = vi.hoisted(() =>
  vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  }),
);
const readDistillDocument = vi.hoisted(() =>
  vi.fn(async (path: string) => files.get(path) ?? null),
);

vi.mock("@/shared/api/distillStore", () => ({
  isDesktopRuntime: () => true,
  readDistillDocument,
  writeDistillDocument,
  getDistillRoot: async () => null,
  setDistillRoot: async () => undefined,
}));

const {
  CONDUCTOR_GRAPH_DOCUMENT,
  CONDUCTOR_WAVES_DOCUMENT,
  WAVE_TELEMETRY_DOCUMENT,
} = await import("./conductorDocuments");
const {
  CONDUCTOR_GRAPH_STORAGE_KEY,
  flushConductorGraphWrites,
  hasConductorGraphHydrationFailed,
  hydrateConductorGraph,
  isConductorGraphHydrated,
  markConductorGraphHydrationFailed,
  resetConductorGraphHydrationForTests,
  setConductorGraphHydratedForTests,
  useConductorGraphStore,
  whenConductorGraphHydrated,
} = await import("./conductorGraphStore");
const {
  CONDUCTOR_WAVES_STORAGE_KEY,
  emptyWaveEngineState,
  flushWaveEngineWrites,
  getWaveEngineState,
  hasWaveEngineStateHydrationFailed,
  hydrateWaveEngineState,
  isWaveEngineStateHydrated,
  markWaveEngineStateHydrationFailed,
  resetWaveEngineStateCache,
  resetWaveEngineStateHydrationForTests,
  setWaveEngineState,
  setWaveEngineStateHydratedForTests,
  whenWaveEngineStateHydrated,
  withWaveTombstone,
} = await import("./waveStore");
const { createWaveState } = await import("./waveEngine");
const {
  bumpWaveTelemetryCounter,
  countPlanlessConductorTurn,
  flushWaveTelemetryWrites,
  getWaveTelemetry,
  hydrateWaveTelemetry,
  isWaveTelemetryHydrated,
  resetWaveTelemetryForTests,
} = await import("./waveTelemetryStore");

import type { SessionNode } from "./types";

function node(sessionId: string): SessionNode {
  return {
    sessionId,
    projectId: "p1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "c1",
    rootConductorId: "c1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status: "running",
  };
}

beforeEach(async () => {
  // A debounced write the previous case left queued would land in this one.
  await flushConductorGraphWrites();
  await flushWaveEngineWrites();
  await flushWaveTelemetryWrites();
  files.clear();
  window.localStorage.clear();
  readDistillDocument.mockImplementation(
    async (path: string) => files.get(path) ?? null,
  );
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  resetConductorGraphHydrationForTests();
  resetWaveEngineStateCache();
  resetWaveEngineStateHydrationForTests();
  setWaveEngineState(emptyWaveEngineState());
  resetWaveTelemetryForTests();
});

/** One rejected read of `path`, then the file map answers as usual. */
function rejectNextRead(path: string): void {
  readDistillDocument.mockImplementationOnce(async (requested: string) => {
    if (requested === path) throw new Error("EPERM: sharing violation");
    return files.get(requested) ?? null;
  });
}

describe("the conductor's state lives in the Distill folder (P24)", () => {
  it("writes the graph to the folder instead of localStorage", async () => {
    await hydrateConductorGraph();
    useConductorGraphStore.getState().registerNode(node("w1"));
    await flushConductorGraphWrites();
    expect(files.has(CONDUCTOR_GRAPH_DOCUMENT)).toBe(true);
    expect(window.localStorage.getItem(CONDUCTOR_GRAPH_STORAGE_KEY)).toBeNull();
  });

  it("migrates a browser copy into the folder once, then drops it", async () => {
    // The one-way door: after this the folder is the only source, so a second
    // copy can never drift out of step with it.
    window.localStorage.setItem(
      CONDUCTOR_GRAPH_STORAGE_KEY,
      JSON.stringify({ version: 1, nodes: [node("old")], reports: [] }),
    );
    await hydrateConductorGraph();
    expect(useConductorGraphStore.getState().nodesById.old?.sessionId).toBe(
      "old",
    );
    expect(files.has(CONDUCTOR_GRAPH_DOCUMENT)).toBe(true);
    expect(window.localStorage.getItem(CONDUCTOR_GRAPH_STORAGE_KEY)).toBeNull();
  });

  it("never lets the folder overwrite a node the session already made", async () => {
    // Hydration is asynchronous and the app is not paused for it. A node
    // registered in that window is more certainly true than the file.
    files.set(
      CONDUCTOR_GRAPH_DOCUMENT,
      JSON.stringify({
        version: 1,
        nodes: [{ ...node("w1"), status: "completed" }],
        reports: [],
      }),
    );
    useConductorGraphStore.getState().registerNode(node("w1"));
    await hydrateConductorGraph();
    expect(useConductorGraphStore.getState().nodesById.w1?.status).toBe(
      "running",
    );
  });

  it("adds the waves of the previous run and keeps the live one", async () => {
    const stored = createWaveState({
      waveId: "old-wave",
      conductorSessionId: "c1",
      rootRequestId: "r1",
      planMessageId: "m1",
      steps: [{ role: "brigade", subtask: "do a thing", access: [] }],
      createdAt: 1,
    });
    const live = createWaveState({
      waveId: "live-wave",
      conductorSessionId: "c1",
      rootRequestId: "r2",
      planMessageId: "m2",
      steps: [{ role: "brigade", subtask: "do another thing", access: [] }],
      createdAt: 2,
    });
    files.set(
      CONDUCTOR_WAVES_DOCUMENT,
      JSON.stringify({
        version: 2,
        waves: [stored],
        tombstones: [
          {
            planMessageId: "m0",
            conductorSessionId: "c1",
            outcome: "spawned",
            at: 1,
          },
        ],
      }),
    );
    setWaveEngineState({ ...emptyWaveEngineState(), waves: [live] });
    await hydrateWaveEngineState();
    const waves = getWaveEngineState().waves.map((wave) => wave.waveId);
    expect(waves).toEqual(["old-wave", "live-wave"]);
    // The tombstone is what stops a restart re-admitting an old plan as a new
    // root request, so it has to survive the merge too.
    expect(getWaveEngineState().tombstones).toHaveLength(1);
    await flushWaveEngineWrites();
    expect(window.localStorage.getItem(CONDUCTOR_WAVES_STORAGE_KEY)).toBeNull();
  });

  it("says the waves are not ready until the folder has been read", async () => {
    setWaveEngineStateHydratedForTests(false);
    expect(isWaveEngineStateHydrated()).toBe(false);
    const woken = vi.fn();
    whenWaveEngineStateHydrated(woken);
    expect(woken).not.toHaveBeenCalled();
    // Back to the real answer, which on the desktop waits for the read.
    setWaveEngineStateHydratedForTests(null);
    await hydrateWaveEngineState();
    expect(isWaveEngineStateHydrated()).toBe(true);
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it("says the graph is not ready until the folder has been read", async () => {
    setConductorGraphHydratedForTests(false);
    expect(isConductorGraphHydrated()).toBe(false);
    const woken = vi.fn();
    whenConductorGraphHydrated(woken);
    expect(woken).not.toHaveBeenCalled();
    setConductorGraphHydratedForTests(null);
    await hydrateConductorGraph();
    expect(isConductorGraphHydrated()).toBe(true);
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it("unions telemetry records without counting this session twice", async () => {
    files.set(
      WAVE_TELEMETRY_DOCUMENT,
      JSON.stringify({
        version: 1,
        counters: {
          planlessTurns: 7,
          admittedWaves: 3,
          rejectedPlans: 1,
          concurrentRefusals: 0,
        },
        records: [],
        planlessHighWater: {},
      }),
    );
    await hydrateWaveTelemetry();
    expect(getWaveTelemetry().counters.planlessTurns).toBe(7);
    await flushWaveTelemetryWrites();
    expect(files.has(WAVE_TELEMETRY_DOCUMENT)).toBe(true);
  });

  it("adds what a tick counted before telemetry.json landed to the lifetime totals", async () => {
    // The tick is gated on telemetry now, but a count that slips through must
    // still be an increment rather than a replacement: this used to be "live
    // counters if they counted anything, else the folder's", so one planless
    // turn counted early turned admittedWaves 300 into 1.
    files.set(
      WAVE_TELEMETRY_DOCUMENT,
      JSON.stringify({
        version: 1,
        counters: {
          planlessTurns: 40,
          admittedWaves: 300,
          rejectedPlans: 2,
          concurrentRefusals: 1,
        },
        records: [],
        planlessHighWater: { "conductor-1": 5_000 },
      }),
    );

    bumpWaveTelemetryCounter("admittedWaves");
    countPlanlessConductorTurn("conductor-1", 9_000);
    await hydrateWaveTelemetry();

    const counters = getWaveTelemetry().counters;
    expect(counters.admittedWaves).toBe(301);
    expect(counters.planlessTurns).toBe(41);
    expect(counters.rejectedPlans).toBe(2);
    // The mark only moves forward, so nothing the previous run counted is
    // counted again.
    expect(getWaveTelemetry().planlessHighWater["conductor-1"]).toBe(9_000);

    // And from here an increment lands on the merged total, once.
    bumpWaveTelemetryCounter("admittedWaves");
    expect(getWaveTelemetry().counters.admittedWaves).toBe(302);
  });

  it("does not count a turn the previous run already counted", async () => {
    files.set(
      WAVE_TELEMETRY_DOCUMENT,
      JSON.stringify({
        version: 1,
        counters: {
          planlessTurns: 40,
          admittedWaves: 0,
          rejectedPlans: 0,
          concurrentRefusals: 0,
        },
        records: [],
        planlessHighWater: { "conductor-1": 9_000 },
      }),
    );
    await hydrateWaveTelemetry();
    countPlanlessConductorTurn("conductor-1", 8_000);
    expect(getWaveTelemetry().counters.planlessTurns).toBe(40);
  });
});

describe("a folder that could not be read is never overwritten", () => {
  // The three documents are the only copy of every past executor, report and
  // tombstone. A read that fails — a locked file at startup, say — must leave
  // the store unhydrated for writing: the first mutation of the session used
  // to replace the file with the near-empty in-memory copy.
  const storedGraph = JSON.stringify({
    version: 1,
    nodes: [{ ...node("old"), status: "completed" }],
    reports: [],
  });

  it("keeps the graph unhydrated and holds its writes until a read succeeds", async () => {
    files.set(CONDUCTOR_GRAPH_DOCUMENT, storedGraph);
    rejectNextRead(CONDUCTOR_GRAPH_DOCUMENT);

    await expect(hydrateConductorGraph()).rejects.toThrow("sharing violation");
    expect(isConductorGraphHydrated()).toBe(false);
    expect(hasConductorGraphHydrationFailed()).toBe(false);

    // This session's work still lands in memory…
    useConductorGraphStore.getState().registerNode(node("w1"));
    await flushConductorGraphWrites();
    // …but the file is untouched.
    expect(files.get(CONDUCTOR_GRAPH_DOCUMENT)).toBe(storedGraph);

    // The read is tried again and succeeds: the folder joins memory, memory
    // wins on conflict, and the held write goes through with both.
    await hydrateConductorGraph();
    expect(isConductorGraphHydrated()).toBe(true);
    const nodes = useConductorGraphStore.getState().nodesById;
    expect(Object.keys(nodes).sort()).toEqual(["old", "w1"]);
    await flushConductorGraphWrites();
    const written = JSON.parse(files.get(CONDUCTOR_GRAPH_DOCUMENT) ?? "{}");
    expect(
      written.nodes.map((entry: SessionNode) => entry.sessionId).sort(),
    ).toEqual(["old", "w1"]);
  });

  it("keeps the waves unhydrated and holds its writes until a read succeeds", async () => {
    const storedWaves = JSON.stringify({
      version: 2,
      waves: [],
      tombstones: [
        {
          planMessageId: "m0",
          conductorSessionId: "c1",
          outcome: "spawned",
          at: 1,
        },
      ],
    });
    files.set(CONDUCTOR_WAVES_DOCUMENT, storedWaves);
    rejectNextRead(CONDUCTOR_WAVES_DOCUMENT);

    await expect(hydrateWaveEngineState()).rejects.toThrow("sharing violation");
    expect(isWaveEngineStateHydrated()).toBe(false);

    setWaveEngineState(
      withWaveTombstone(getWaveEngineState(), {
        planMessageId: "m1",
        conductorSessionId: "c1",
        outcome: "rejected",
        at: 2,
      }),
    );
    await flushWaveEngineWrites();
    expect(files.get(CONDUCTOR_WAVES_DOCUMENT)).toBe(storedWaves);

    await hydrateWaveEngineState();
    expect(isWaveEngineStateHydrated()).toBe(true);
    expect(
      getWaveEngineState().tombstones.map((entry) => entry.planMessageId),
    ).toEqual(["m0", "m1"]);
    await flushWaveEngineWrites();
    const written = JSON.parse(files.get(CONDUCTOR_WAVES_DOCUMENT) ?? "{}");
    expect(
      written.tombstones.map(
        (entry: { planMessageId: string }) => entry.planMessageId,
      ),
    ).toEqual(["m0", "m1"]);
  });

  it("keeps the telemetry unhydrated and holds its writes until a read succeeds", async () => {
    const storedTelemetry = JSON.stringify({
      version: 1,
      counters: {
        planlessTurns: 7,
        admittedWaves: 3,
        rejectedPlans: 1,
        concurrentRefusals: 0,
      },
      records: [],
      planlessHighWater: {},
    });
    files.set(WAVE_TELEMETRY_DOCUMENT, storedTelemetry);
    rejectNextRead(WAVE_TELEMETRY_DOCUMENT);

    await expect(hydrateWaveTelemetry()).rejects.toThrow("sharing violation");
    expect(isWaveTelemetryHydrated()).toBe(false);

    bumpWaveTelemetryCounter("rejectedPlans");
    await flushWaveTelemetryWrites();
    expect(files.get(WAVE_TELEMETRY_DOCUMENT)).toBe(storedTelemetry);

    await hydrateWaveTelemetry();
    expect(isWaveTelemetryHydrated()).toBe(true);
    await flushWaveTelemetryWrites();
    // The held write lands once the file is known.
    expect(files.get(WAVE_TELEMETRY_DOCUMENT)).not.toBe(storedTelemetry);
    const written = JSON.parse(files.get(WAVE_TELEMETRY_DOCUMENT) ?? "{}");
    expect(written.counters.rejectedPlans).toBeGreaterThanOrEqual(1);
  });

  it("writes this session's early changes once the folder has been read", async () => {
    // No file at all: the read succeeds with nothing to merge, and the write
    // held back before it lands now rather than waiting for the next change.
    rejectNextRead(CONDUCTOR_GRAPH_DOCUMENT);
    await expect(hydrateConductorGraph()).rejects.toThrow();
    useConductorGraphStore.getState().registerNode(node("w1"));
    await flushConductorGraphWrites();
    expect(files.has(CONDUCTOR_GRAPH_DOCUMENT)).toBe(false);

    await hydrateConductorGraph();
    await flushConductorGraphWrites();
    const written = JSON.parse(files.get(CONDUCTOR_GRAPH_DOCUMENT) ?? "{}");
    expect(written.nodes.map((entry: SessionNode) => entry.sessionId)).toEqual([
      "w1",
    ]);
  });

  it("releases the waiters when the caller gives up on the read, and says so", () => {
    // A waiter parked on a document that will never arrive must not park for
    // the rest of the session; it runs, finds the store unhydrated and failed,
    // and decides for itself. The engine tick, for one, then stays off.
    const graphWoken = vi.fn();
    const wavesWoken = vi.fn();
    setConductorGraphHydratedForTests(false);
    setWaveEngineStateHydratedForTests(false);
    whenConductorGraphHydrated(graphWoken);
    whenWaveEngineStateHydrated(wavesWoken);
    setConductorGraphHydratedForTests(null);
    setWaveEngineStateHydratedForTests(null);

    markConductorGraphHydrationFailed();
    markWaveEngineStateHydrationFailed();

    expect(graphWoken).toHaveBeenCalledTimes(1);
    expect(wavesWoken).toHaveBeenCalledTimes(1);
    expect(isConductorGraphHydrated()).toBe(false);
    expect(hasConductorGraphHydrationFailed()).toBe(true);
    expect(isWaveEngineStateHydrated()).toBe(false);
    expect(hasWaveEngineStateHydrationFailed()).toBe(true);
    // A waiter added after the failure runs at once, for the same reason.
    const late = vi.fn();
    whenConductorGraphHydrated(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
