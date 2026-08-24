import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_GRAPH_NODES,
  MAX_GRAPH_REPORTS,
  boundConductorGraph,
  resetGraphBoundsWarningForTests,
  type ConductorGraphSlices,
} from "./graphBounds";
import type { RunStatus, SessionNode, StructuredReport } from "./types";

function node(
  sessionId: string,
  status: RunStatus,
  overrides: Partial<SessionNode> = {},
): SessionNode {
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
    status,
    ...overrides,
  };
}

function report(runId: string, published = true): StructuredReport {
  return {
    runId,
    status: "completed",
    summary: "done",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    publishedToParent: published,
  };
}

function stateOf(
  nodes: SessionNode[],
  reports: StructuredReport[] = [],
): ConductorGraphSlices {
  return {
    nodesById: Object.fromEntries(nodes.map((n) => [n.sessionId, n])),
    reportsByRunId: Object.fromEntries(reports.map((r) => [r.runId, r])),
  };
}

const NO_LIVE_WAVES: ReadonlySet<string> = new Set();

describe("boundConductorGraph", () => {
  beforeEach(() => {
    resetGraphBoundsWarningForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same object while under the bound", () => {
    const state = stateOf([node("a", "completed")], [report("run-a")]);
    expect(boundConductorGraph(state, NO_LIVE_WAVES)).toBe(state);
  });

  it("evicts the oldest finished workers first, down to the bound", () => {
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 3 }, (_, index) =>
      node(`w-${index}`, "completed", {
        createdAt: index,
        finishedAt: index + 1,
      }),
    );
    const bounded = boundConductorGraph(stateOf(nodes), NO_LIVE_WAVES);

    expect(Object.keys(bounded.nodesById)).toHaveLength(MAX_GRAPH_NODES);
    // The three oldest by finishedAt are the ones gone.
    expect(bounded.nodesById["w-0"]).toBeUndefined();
    expect(bounded.nodesById["w-1"]).toBeUndefined();
    expect(bounded.nodesById["w-2"]).toBeUndefined();
    expect(bounded.nodesById["w-3"]).toBeDefined();
  });

  it("never evicts conductors, live runs, or children of live waves", () => {
    const protectedNodes = [
      node("the-conductor", "stopped", { role: "conductor", createdAt: 0 }),
      node("still-running", "running", { createdAt: 1 }),
      node("live-wave-child", "completed", {
        waveId: "wave-live",
        createdAt: 2,
      }),
    ];
    const filler = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, index) =>
      node(`old-${index}`, "completed", { createdAt: 100 + index }),
    );
    const bounded = boundConductorGraph(
      stateOf([...protectedNodes, ...filler]),
      new Set(["wave-live"]),
    );

    expect(bounded.nodesById["the-conductor"]).toBeDefined();
    expect(bounded.nodesById["still-running"]).toBeDefined();
    expect(bounded.nodesById["live-wave-child"]).toBeDefined();
    // The evictions came out of the old finished filler instead.
    expect(Object.keys(bounded.nodesById)).toHaveLength(MAX_GRAPH_NODES);
  });

  it("warns — once — when everything over the bound is unevictable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 2 }, (_, index) =>
      node(`busy-${index}`, "running", { createdAt: index }),
    );
    const state = stateOf(nodes);

    const bounded = boundConductorGraph(state, NO_LIVE_WAVES);
    boundConductorGraph(bounded, NO_LIVE_WAVES);

    // Nothing could move, and the failure is visible rather than silent.
    expect(Object.keys(bounded.nodesById)).toHaveLength(MAX_GRAPH_NODES + 2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops orphan reports only once the report map is over its own bound", () => {
    const keptNode = node("kept", "completed");
    const underBound = stateOf(
      [keptNode],
      [report("run-kept"), report("orphan-run")],
    );
    // An orphan under the bound survives — it may simply predate its node.
    expect(boundConductorGraph(underBound, NO_LIVE_WAVES)).toBe(underBound);

    const reports = [
      report("run-kept"),
      ...Array.from({ length: MAX_GRAPH_REPORTS + 2 }, (_, index) =>
        // Unpublished orphans are dropped last.
        report(`orphan-${index}`, index % 2 === 0),
      ),
    ];
    const bounded = boundConductorGraph(
      stateOf([keptNode], reports),
      NO_LIVE_WAVES,
    );
    expect(Object.keys(bounded.reportsByRunId)).toHaveLength(MAX_GRAPH_REPORTS);
    // The referenced report is untouchable.
    expect(bounded.reportsByRunId["run-kept"]).toBeDefined();
  });
});
