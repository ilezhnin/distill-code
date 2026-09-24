import { beforeEach, describe, expect, it } from "vitest";

import { useMemoryStore } from "@/features/memory/stores/memoryStore";

import { useConductorGraphStore } from "./conductorGraphStore";
import { isWaveManagedSession } from "./waveManagedSession";

describe("isWaveManagedSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useMemoryStore.setState({ waveExecutorSessionIds: [] });
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
});
