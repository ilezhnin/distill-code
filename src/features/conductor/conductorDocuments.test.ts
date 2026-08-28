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
  hydrateConductorGraph,
  useConductorGraphStore,
} = await import("./conductorGraphStore");
const {
  CONDUCTOR_WAVES_STORAGE_KEY,
  emptyWaveEngineState,
  flushWaveEngineWrites,
  getWaveEngineState,
  hydrateWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
} = await import("./waveStore");
const { createWaveState } = await import("./waveEngine");
const {
  flushWaveTelemetryWrites,
  getWaveTelemetry,
  hydrateWaveTelemetry,
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

beforeEach(() => {
  files.clear();
  window.localStorage.clear();
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  resetWaveEngineStateCache();
  setWaveEngineState(emptyWaveEngineState());
  resetWaveTelemetryForTests();
});

describe("the conductor's state lives in the Distill folder (P24)", () => {
  it("writes the graph to the folder instead of localStorage", async () => {
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
});
