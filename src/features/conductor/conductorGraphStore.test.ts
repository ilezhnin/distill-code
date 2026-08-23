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
