import { describe, expect, it } from "vitest";

import {
  brigadeWaitIndicator,
  summarizeBrigadeActivity,
  withLiveJobStatus,
  workingChildCountForSession,
} from "./brigadeActivity";
import type { RunStatus, SessionNode } from "./types";

function node(
  sessionId: string,
  status: RunStatus,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    displayName: sessionId,
    status,
    ...overrides,
  } as SessionNode;
}

const conductor = node("conductor-1", "completed", {
  role: "conductor",
  parentSessionId: null,
  rootConductorId: null,
});

describe("withLiveJobStatus", () => {
  it("shows an agent whose turn is over but whose job runs as waiting", () => {
    const nodes = [node("w1", "completed"), node("w2", "completed")];
    const shown = withLiveJobStatus(nodes, new Set(["w1"]));
    expect(shown.map((entry) => entry.status)).toEqual([
      "waiting",
      "completed",
    ]);
    expect(summarizeBrigadeActivity(shown)).toEqual({ working: 1, done: 1 });
    expect(
      brigadeWaitIndicator({ chatState: "idle", children: shown }).visible,
    ).toBe(true);
  });

  it("keeps a running agent's own status and the same array when nothing changes", () => {
    const nodes = [node("w1", "running"), node("w2", "failed")];
    expect(withLiveJobStatus(nodes, new Set(["w1"]))).toBe(nodes);
    expect(withLiveJobStatus(nodes, new Set())).toBe(nodes);
  });
});

describe("workingChildCountForSession", () => {
  it("counts an agent that waits on its job as working", () => {
    const nodesById = {
      [conductor.sessionId]: conductor,
      w1: node("w1", "completed"),
      w2: node("w2", "completed"),
    };
    expect(workingChildCountForSession(nodesById, "conductor-1")).toBe(0);
    expect(
      workingChildCountForSession(
        nodesById,
        "conductor-1",
        [],
        new Set(["w2"]),
      ),
    ).toBe(1);
    // The chat's own job is not one of its agents.
    expect(
      workingChildCountForSession(
        nodesById,
        "conductor-1",
        [],
        new Set(["conductor-1"]),
      ),
    ).toBe(0);
  });
});
