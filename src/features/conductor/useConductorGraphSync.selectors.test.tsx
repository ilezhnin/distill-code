/**
 * What wakes the conductor sync pass.
 *
 * The pass walks every node in the graph, derives a status and a report for
 * each and then runs the wave engine tick. It used to be subscribed to *any*
 * change of the chat store and of the graph store — and the chat store is
 * written once per streamed token, plus on every draft keystroke, scroll target
 * and read flag. These cases pin the slices it actually depends on.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionNode } from "./types";

const runWaveEngineTick = vi.hoisted(() => vi.fn());
vi.mock("./waveRunner", () => ({ runWaveEngineTick }));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => {}),
}));

const { useConductorGraphSync } = await import("./useConductorGraphSync");
const { useConductorGraphStore } = await import("./conductorGraphStore");
const { useChatStore } = await import("@/features/chat/stores/chatStore");

function workerNode(sessionId: string): SessionNode {
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

describe("what wakes the conductor sync pass", () => {
  beforeEach(() => {
    window.localStorage.clear();
    runWaveEngineTick.mockClear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
  });

  afterEach(() => {
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  });

  it("ignores chat-store writes it cannot derive anything from", () => {
    useConductorGraphStore.getState().registerNode(workerNode("worker-1"));
    const view = renderHook(() => useConductorGraphSync());
    try {
      runWaveEngineTick.mockClear();

      act(() => {
        useChatStore.setState({ isConnected: true });
      });
      act(() => {
        useChatStore.setState({ draftsBySession: { "worker-1": "typing" } });
      });
      act(() => {
        useChatStore.setState({
          scrollTargetMessageBySession: { a: { messageId: "m-1" } },
        });
      });

      expect(runWaveEngineTick).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it("still runs on a new message, a runtime change and a queued first send", () => {
    useConductorGraphStore.getState().registerNode(workerNode("worker-1"));
    const view = renderHook(() => useConductorGraphSync());
    try {
      for (const write of [
        () =>
          useChatStore.setState({
            messagesBySession: {
              "worker-1": [
                {
                  id: "m-1",
                  role: "assistant",
                  created: 1,
                  content: [{ type: "text", text: "done" }],
                  metadata: { completionStatus: "completed" },
                },
              ],
            },
          }),
        () => useChatStore.getState().setChatState("worker-1", "streaming"),
        () =>
          useChatStore.setState({
            queuedMessageBySession: { "worker-1": [] },
          }),
      ]) {
        runWaveEngineTick.mockClear();
        act(write);
        expect(runWaveEngineTick).toHaveBeenCalled();
      }
    } finally {
      view.unmount();
    }
  });

  it("still runs when a node or a report changes on the graph", () => {
    const view = renderHook(() => useConductorGraphSync());
    try {
      runWaveEngineTick.mockClear();
      act(() => {
        useConductorGraphStore.getState().registerNode(workerNode("worker-2"));
      });
      expect(runWaveEngineTick).toHaveBeenCalled();

      runWaveEngineTick.mockClear();
      act(() => {
        useConductorGraphStore.getState().attachReport({
          runId: "run-worker-2",
          status: "completed",
          summary: "did it",
          decisions: [],
          artifacts: [],
          risks: [],
          needsOperator: false,
          nextSuggestedTask: null,
        });
      });
      expect(runWaveEngineTick).toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});
