import { beforeEach, describe, expect, it, vi } from "vitest";

import { CONDUCTOR_GRAPH_STORAGE_KEY } from "./conductorGraphStore";
import type { SessionNode } from "./types";

/**
 * The graph hydrates from localStorage at module evaluation time, so every
 * "load" assertion re-imports the module with the storage already seeded.
 */
async function loadGraph() {
  vi.resetModules();
  const { useConductorGraphStore } = await import("./conductorGraphStore");
  return useConductorGraphStore;
}

function readPersistedNodes(): Array<Partial<SessionNode>> {
  const raw = window.localStorage.getItem(CONDUCTOR_GRAPH_STORAGE_KEY);
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw ?? "{}") as {
    version: number;
    nodes: Array<Partial<SessionNode>>;
  };
  expect(parsed.version).toBe(1);
  return parsed.nodes;
}

describe("conductorGraphStore persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("loads persisted nodes without managedBy as ui", async () => {
    window.localStorage.setItem(
      CONDUCTOR_GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            sessionId: "legacy-1",
            projectId: "project",
            role: "orchestrator",
            parentSessionId: "conductor-1",
            rootConductorId: "conductor-1",
            runId: "run-1",
            harnessId: "goose",
            displayName: "Atlas",
            status: "running",
            anchorMessageId: "message-1",
          },
        ],
        reports: [],
      }),
    );

    const store = await loadGraph();
    const node = store.getState().getNode("legacy-1");

    expect(node?.managedBy).toBe("ui");
    expect(node?.role).toBe("orchestrator");
    expect(node?.anchorMessageId).toBe("message-1");
    expect(node?.waveId).toBeUndefined();
    expect(node?.stepIndex).toBeUndefined();
  });

  it("falls back to ui when the persisted managedBy is not a known value", async () => {
    window.localStorage.setItem(
      CONDUCTOR_GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            sessionId: "bogus-1",
            projectId: "project",
            role: "worker",
            parentSessionId: "conductor-1",
            rootConductorId: "conductor-1",
            runId: null,
            harnessId: "goose",
            displayName: "Curie",
            status: "completed",
            managedBy: "sideways",
            stepIndex: "2",
          },
        ],
        reports: [],
      }),
    );

    const store = await loadGraph();
    const node = store.getState().getNode("bogus-1");

    expect(node?.managedBy).toBe("ui");
    expect(node?.stepIndex).toBeUndefined();
  });

  it("round-trips managedBy, waveId and stepIndex through persist and load", async () => {
    const store = await loadGraph();
    store.getState().registerNode({
      sessionId: "wave-child-1",
      projectId: "project",
      role: "worker",
      managedBy: "wave",
      parentSessionId: "conductor-1",
      rootConductorId: "conductor-1",
      runId: "run-2",
      harnessId: "goose",
      displayName: "Bohr",
      status: "starting",
      anchorMessageId: "plan-message-1",
      waveId: "wave-1",
      stepIndex: 2,
    });

    expect(readPersistedNodes()).toContainEqual(
      expect.objectContaining({
        sessionId: "wave-child-1",
        managedBy: "wave",
        waveId: "wave-1",
        stepIndex: 2,
      }),
    );

    const reloaded = await loadGraph();
    const node = reloaded.getState().getNode("wave-child-1");

    expect(node?.managedBy).toBe("wave");
    expect(node?.waveId).toBe("wave-1");
    expect(node?.stepIndex).toBe(2);
    expect(node?.anchorMessageId).toBe("plan-message-1");
  });
});

describe("promoting a draft conductor session", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function conductorNode(sessionId: string): SessionNode {
    return {
      sessionId,
      projectId: "project",
      role: "conductor",
      managedBy: "ui",
      parentSessionId: null,
      rootConductorId: sessionId,
      runId: null,
      harnessId: "goose",
      displayName: "Producer",
      status: "running",
    };
  }

  it("carries the conductor's live wave across the promotion", async () => {
    const store = await loadGraph();
    const { createWaveState } = await import("./waveEngine");
    const {
      getWaveEngineState,
      pruneOrphanedWaves,
      resetWaveEngineStateCache,
      setWaveEngineState,
      withWave,
      withWaveTombstone,
      emptyWaveEngineState,
    } = await import("./waveStore");

    resetWaveEngineStateCache();
    store.getState().registerNode(conductorNode("draft-1"));
    // The conductor's first settled turn carried a plan, so the wave was
    // created under the draft id the graph node still had.
    setWaveEngineState(
      withWaveTombstone(
        withWave(
          emptyWaveEngineState(),
          createWaveState({
            waveId: "w1",
            conductorSessionId: "draft-1",
            planMessageId: "plan-1",
            steps: [{ role: "scout", subtask: "Look", access: [] }],
            createdAt: 1,
          }),
        ),
        {
          planMessageId: "plan-1",
          conductorSessionId: "draft-1",
          outcome: "spawned",
          at: 1,
        },
      ),
    );

    store.getState().remapSessionId("draft-1", "backend-1");

    const state = getWaveEngineState();
    expect(state.waves[0].conductorSessionId).toBe("backend-1");
    expect(state.tombstones[0].conductorSessionId).toBe("backend-1");

    // The regression: the next tick prunes waves whose conductor the graph no
    // longer knows, and the graph only knows the backend id now. A wave left
    // holding the draft id is deleted here, with its children still running.
    const conductorIds = new Set(
      Object.values(store.getState().nodesById)
        .filter((node) => node.role === "conductor")
        .map((node) => node.sessionId),
    );
    expect(pruneOrphanedWaves(state, conductorIds).waves).toHaveLength(1);

    resetWaveEngineStateCache();
  });

  it("leaves the waves of other conductors alone", async () => {
    const store = await loadGraph();
    const { createWaveState } = await import("./waveEngine");
    const {
      getWaveEngineState,
      resetWaveEngineStateCache,
      setWaveEngineState,
      withWave,
      emptyWaveEngineState,
    } = await import("./waveStore");

    resetWaveEngineStateCache();
    store.getState().registerNode(conductorNode("draft-1"));
    store.getState().registerNode(conductorNode("other-1"));
    setWaveEngineState(
      withWave(
        emptyWaveEngineState(),
        createWaveState({
          waveId: "w-other",
          conductorSessionId: "other-1",
          planMessageId: "plan-other",
          steps: [{ role: "scout", subtask: "Look", access: [] }],
          createdAt: 1,
        }),
      ),
    );

    store.getState().remapSessionId("draft-1", "backend-1");

    expect(getWaveEngineState().waves[0].conductorSessionId).toBe("other-1");
    resetWaveEngineStateCache();
  });
});

describe("finishedAt stamping", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function worker(sessionId: string): SessionNode {
    return {
      sessionId,
      projectId: "project",
      role: "worker",
      managedBy: "wave",
      parentSessionId: "conductor-1",
      rootConductorId: "conductor-1",
      runId: `run-${sessionId}`,
      harnessId: "goose",
      displayName: sessionId,
      status: "running",
      createdAt: 1,
    };
  }

  it("stamps the first transition into a terminal status, and only the first", async () => {
    const store = await loadGraph();
    store.getState().registerNode(worker("w1"));

    store.getState().patchNode("w1", { status: "waiting" });
    expect(store.getState().nodesById.w1?.finishedAt).toBeUndefined();

    store.getState().patchNode("w1", { status: "completed" });
    const stamped = store.getState().nodesById.w1?.finishedAt;
    expect(typeof stamped).toBe("number");

    // A later terminal-to-terminal patch (a reconcile demotion, say) must not
    // move the end of a run that already ended.
    store.getState().patchNode("w1", { status: "stopped" });
    expect(store.getState().nodesById.w1?.finishedAt).toBe(stamped);

    // And the stamp survives persistence.
    const persisted = readPersistedNodes().find(
      (node) => node.sessionId === "w1",
    );
    expect(persisted?.finishedAt).toBe(stamped);
  });

  it("respects an explicit finishedAt supplied by the caller", async () => {
    const store = await loadGraph();
    store.getState().registerNode(worker("w2"));
    store.getState().patchNode("w2", { status: "completed", finishedAt: 42 });
    expect(store.getState().nodesById.w2?.finishedAt).toBe(42);
  });
});
