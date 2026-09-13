import { beforeEach, describe, expect, it } from "vitest";

import { useMemoryStore } from "@/features/memory/stores/memoryStore";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";
import { isWaveManagedSession } from "./waveManagedSession";

function node(over: Partial<SessionNode> & { sessionId: string }): SessionNode {
  return {
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: "run-1",
    harnessId: "goose",
    displayName: over.sessionId,
    status: "completed",
    ...over,
  };
}

describe("isWaveManagedSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useMemoryStore.setState({ waveExecutorSessionIds: [] });
  });

  it("is true for a wave child the graph still holds", () => {
    useConductorGraphStore.getState().registerNode(node({ sessionId: "w1" }));

    expect(isWaveManagedSession("w1")).toBe(true);
  });

  it("stays true after the graph's bound has evicted the child's node", () => {
    // The graph evicts a finished wave child's node first, and the callers of
    // this decide what reaches that chat's prompt — including the operator's
    // `<memory>` block, which LAWS/MEMORY.md forbids a wave-spawned executor
    // from receiving. The record of the child outlives its node for that reason.
    useMemoryStore.setState({ waveExecutorSessionIds: ["w1"] });

    expect(useConductorGraphStore.getState().nodesById.w1).toBeUndefined();
    expect(isWaveManagedSession("w1")).toBe(true);
  });

  it("is false for an ordinary chat and for no session at all", () => {
    useConductorGraphStore
      .getState()
      .registerNode(
        node({ sessionId: "plain", role: "conductor", managedBy: "ui" }),
      );

    expect(isWaveManagedSession("plain")).toBe(false);
    expect(isWaveManagedSession("never-seen")).toBe(false);
    expect(isWaveManagedSession(null)).toBe(false);
    expect(isWaveManagedSession(undefined)).toBe(false);
  });
});
