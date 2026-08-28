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

  it("never groups wave workers — the wave publishes its own digest", () => {
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
    ];
    expect(groupPublishableTurns(nodes, () => [])).toEqual([]);
  });

  it("keeps the legacy tree and drops the wave worker beside it", () => {
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
    expect(groups).toHaveLength(1);
    expect(groups[0].leaves.map((leaf) => leaf.sessionId)).toEqual(["orch-1"]);
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

  it("publishes an agent-cli session to its parent as its own group (P19d)", () => {
    // The module header always claimed it covered sessions registered from
    // outside the UI. It did not: berdctl registers a worker under its
    // parent, never an orchestrator shell, so the role filter dropped it and
    // its report never reached the parent at all.
    const cli = node({
      sessionId: "cli-1",
      role: "worker",
      managedBy: "agent-cli",
      parentSessionId: "conductor-1",
    });
    const groups = groupPublishableTurns([cli], () => []);
    expect(groups).toHaveLength(1);
    expect(groups[0].parentSessionId).toBe("conductor-1");
    expect(groups[0].leaves.map((leaf) => leaf.sessionId)).toEqual(["cli-1"]);
  });

  it("does not publish an agent-cli session twice when it is also a leaf", () => {
    const orchestrator = node({
      sessionId: "orch-1",
      role: "orchestrator",
      parentSessionId: "conductor-1",
      anchorMessageId: "msg-1",
    });
    const cliWorker = node({
      sessionId: "cli-1",
      managedBy: "agent-cli",
      parentSessionId: "orch-1",
    });
    const groups = groupPublishableTurns([orchestrator, cliWorker], (parent) =>
      parent === "orch-1" ? [cliWorker] : [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].leaves.map((leaf) => leaf.sessionId)).toEqual(["cli-1"]);
  });

  it("still leaves an agent-cli session with no parent alone", () => {
    const orphan = node({
      sessionId: "cli-orphan",
      managedBy: "agent-cli",
      parentSessionId: null,
    });
    expect(groupPublishableTurns([orphan], () => [])).toEqual([]);
  });
});
