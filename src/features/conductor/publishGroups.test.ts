import { describe, expect, it } from "vitest";

import { groupPublishableTurns } from "./publishGroups";
import type { SessionNode } from "./types";

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${overrides.sessionId}`,
    harnessId: "goose",
    displayName: overrides.sessionId,
    status: "completed",
    ...overrides,
  };
}

describe("groupPublishableTurns", () => {
  it("keeps the legacy orchestrator grouping: leaves are its workers", () => {
    const orchestrator = node({
      sessionId: "orch-1",
      role: "orchestrator",
      anchorMessageId: "msg-1",
    });
    const worker = node({ sessionId: "w-1", parentSessionId: "orch-1" });
    const groups = groupPublishableTurns([orchestrator, worker], (parentId) =>
      parentId === "orch-1" ? [worker] : [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].parentSessionId).toBe("conductor-1");
    expect(groups[0].leaves.map((leaf) => leaf.sessionId)).toEqual(["w-1"]);
  });

  it("falls back to the orchestrator itself when it has no workers", () => {
    const orchestrator = node({ sessionId: "orch-1", role: "orchestrator" });
    const groups = groupPublishableTurns([orchestrator], () => []);
    expect(groups[0].leaves.map((leaf) => leaf.sessionId)).toEqual(["orch-1"]);
  });

  it("groups two orchestrators of the same turn together", () => {
    const first = node({
      sessionId: "orch-1",
      role: "orchestrator",
      anchorMessageId: "msg-1",
    });
    const second = node({
      sessionId: "orch-2",
      role: "orchestrator",
      anchorMessageId: "msg-1",
    });
    const groups = groupPublishableTurns([first, second], () => []);
    expect(groups).toHaveLength(1);
    expect(groups[0].leaves.map((leaf) => leaf.sessionId)).toEqual([
      "orch-1",
      "orch-2",
    ]);
  });

  it("groups wave workers by their plan message", () => {
    const nodes = [
      node({
        sessionId: "w-1",
        managedBy: "wave",
        waveId: "wave-1",
        stepIndex: 1,
        anchorMessageId: "plan-1",
      }),
      node({
        sessionId: "w-0",
        managedBy: "wave",
        waveId: "wave-1",
        stepIndex: 0,
        anchorMessageId: "plan-1",
      }),
      node({
        sessionId: "w-2",
        managedBy: "wave",
        waveId: "wave-2",
        stepIndex: 0,
        anchorMessageId: "plan-2",
      }),
    ];
    const groups = groupPublishableTurns(nodes, () => []);
    expect(groups).toHaveLength(2);
    const first = groups.find((group) => group.key.endsWith("plan-1"));
    expect(first?.leaves.map((leaf) => leaf.sessionId)).toEqual(["w-0", "w-1"]);
  });

  it("withholds a wave whose steps are still running", () => {
    const nodes = [
      node({
        sessionId: "w-0",
        managedBy: "wave",
        waveId: "wave-1",
        stepIndex: 0,
        anchorMessageId: "plan-1",
      }),
    ];
    expect(
      groupPublishableTurns(
        nodes,
        () => [],
        (waveId) => waveId === "wave-1",
      ),
    ).toEqual([]);
    expect(groupPublishableTurns(nodes, () => [])).toHaveLength(1);
  });

  it("keeps waves and legacy trees in separate groups", () => {
    const orchestrator = node({
      sessionId: "orch-1",
      role: "orchestrator",
      anchorMessageId: "msg-1",
    });
    const waveWorker = node({
      sessionId: "w-1",
      managedBy: "wave",
      waveId: "wave-1",
      stepIndex: 0,
      anchorMessageId: "plan-1",
    });
    const groups = groupPublishableTurns([orchestrator, waveWorker], () => []);
    expect(groups).toHaveLength(2);
  });

  it("ignores nodes with no parent and non-worker wave nodes", () => {
    const conductor = node({
      sessionId: "conductor-1",
      role: "conductor",
      parentSessionId: null,
    });
    const strayWaveOrchestrator = node({
      sessionId: "orch-1",
      role: "orchestrator",
      managedBy: "wave",
    });
    expect(
      groupPublishableTurns([conductor, strayWaveOrchestrator], () => []),
    ).toEqual([]);
  });
});
