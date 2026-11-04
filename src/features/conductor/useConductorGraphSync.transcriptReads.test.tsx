import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SessionNode } from "./types";

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/benchmarks/lib/ownedTaskExecution", () => ({
  ownedTaskExecution: { getMode: vi.fn(async () => null) },
}));

const loadSessionMessages = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages,
}));

const CONDUCTOR_ID = "conductor-1";

function stoppedStep(index: number): SessionNode {
  return {
    sessionId: `step-${index}`,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: CONDUCTOR_ID,
    rootConductorId: CONDUCTOR_ID,
    runId: `run-${index}`,
    harnessId: "claude-acp",
    displayName: `Step ${index}`,
    status: "cancelled",
    waveId: "wave-1",
    stepIndex: index,
  };
}

describe("useConductorGraphSync transcript reads", () => {
  it("does not read a reported step's transcript again once the cache dropped it", async () => {
    vi.resetModules();
    const [
      { useConductorGraphSync },
      { useConductorGraphStore },
      { useChatStore },
      { useChatSessionStore },
    ] = await Promise.all([
      import("./useConductorGraphSync"),
      import("./conductorGraphStore"),
      import("@/features/chat/stores/chatStore"),
      import("@/features/chat/stores/chatSessionStore"),
    ]);
    useChatSessionStore.setState({ hasHydratedSessions: true });
    // Nothing of the steps is in the message cache: a long conductor has more
    // stopped steps than the cache has room for.
    useChatStore.setState({
      hasHydratedMessageQueues: true,
      messagesBySession: {},
      sessionStateById: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    const graph = useConductorGraphStore.getState();
    for (let index = 0; index < 3; index += 1) {
      graph.registerNode(stoppedStep(index));
      // The report the sync wrote back when the transcript was in the cache.
      graph.attachReport({
        runId: `run-${index}`,
        status: "cancelled",
        summary: "The agent was cancelled.",
        decisions: [],
        artifacts: [],
        risks: [],
        needsOperator: false,
        nextSuggestedTask: null,
        synthesized: true,
      });
    }

    renderHook(() => useConductorGraphSync());
    // Every streamed token of any chat runs the pass again.
    for (let token = 0; token < 5; token += 1) {
      await act(async () => {
        useChatStore.getState().addMessage("someone-else", {
          id: `token-${token}`,
          role: "assistant",
          created: token,
          content: [{ type: "text", text: "…" }],
        });
      });
    }

    expect(loadSessionMessages).not.toHaveBeenCalled();
    expect(useConductorGraphStore.getState().reportsByRunId["run-0"]).toEqual(
      expect.objectContaining({ summary: "The agent was cancelled." }),
    );
  });
});
