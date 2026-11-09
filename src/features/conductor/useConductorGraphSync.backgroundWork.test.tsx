import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";
import type { SessionNode } from "./types";

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => {}),
}));

function workerNode(sessionId: string): SessionNode {
  return {
    sessionId,
    projectId: "invented-project",
    role: "worker",
    managedBy: "agent-cli",
    parentSessionId: "parent-chat",
    rootConductorId: "parent-chat",
    runId: `run-${sessionId}`,
    harnessId: "claude-acp",
    displayName: "Integrator",
    status: "starting",
    createdAt: 1,
  };
}

function reply(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

const REPORT = [
  "The compile finished: 207,900 of 317,083 files pass.",
  "",
  "```distill-report",
  JSON.stringify({
    status: "completed",
    summary: "Recompiled the corpus; 207,900 files pass.",
    decisions: [],
    artifacts: [{ label: "summary.json", path: "build/summary.json" }],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  }),
  "```",
].join("\n");

/** The sync pass keeps module-level memory, so each case starts fresh. */
async function loadModules() {
  vi.resetModules();
  const [
    { useConductorGraphSync },
    { useConductorGraphStore },
    { useChatStore },
    { useChatSessionStore },
    { useBackgroundTasksStore },
    { useMonitorJobStore },
  ] = await Promise.all([
    import("./useConductorGraphSync"),
    import("./conductorGraphStore"),
    import("@/features/chat/stores/chatStore"),
    import("@/features/chat/stores/chatSessionStore"),
    import("@/features/chat/stores/backgroundTasksStore"),
    import("./monitorJobStore"),
  ]);
  useChatStore.setState({ hasHydratedMessageQueues: true });
  useChatSessionStore.setState({ hasHydratedSessions: true });
  renderHook(() => useConductorGraphSync());
  return {
    graph: () => useConductorGraphStore.getState(),
    useChatStore,
    useBackgroundTasksStore,
    useMonitorJobStore,
  };
}

describe("a worker that ends its turn while its background work runs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("keeps working until the work ends, then reports what the work came to", async () => {
    const { graph, useChatStore, useBackgroundTasksStore } =
      await loadModules();
    act(() => {
      graph().registerNode(workerNode("child-1"));
      useChatStore.getState().setChatState("child-1", "streaming");
    });
    // The agent leaves a wait on the compile running and ends its turn.
    act(() => {
      useBackgroundTasksStore.getState().replace("child-1", [
        {
          id: "wait-compile",
          state: "running",
          description: "until compile/summary.json exists",
        },
      ]);
      useChatStore
        .getState()
        .addMessage(
          "child-1",
          reply(
            "m1",
            "The compile is still scanning. I'll pick up when the background wait finishes.",
          ),
        );
      useChatStore.getState().setChatState("child-1", "idle");
    });
    expect(graph().getNode("child-1")?.status).toBe("running");
    expect(graph().getReport("run-child-1")).toBeUndefined();

    // The wait ends and wakes the agent, which reports.
    act(() => {
      useBackgroundTasksStore
        .getState()
        .replace("child-1", [
          { id: "wait-compile", state: "completed", summary: "Exit 0" },
        ]);
      useChatStore.getState().setChatState("child-1", "streaming");
    });
    expect(graph().getNode("child-1")?.status).toBe("running");
    act(() => {
      useChatStore.getState().addMessage("child-1", reply("m2", REPORT));
      useChatStore.getState().setChatState("child-1", "idle");
    });
    expect(graph().getNode("child-1")?.status).toBe("completed");
    expect(graph().getReport("run-child-1")?.summary).toBe(
      "Recompiled the corpus; 207,900 files pass.",
    );
  });

  it("is finished when its reply carries the report, whatever still runs", async () => {
    const { graph, useChatStore, useBackgroundTasksStore } =
      await loadModules();
    act(() => {
      graph().registerNode(workerNode("child-2"));
      useChatStore.getState().setChatState("child-2", "streaming");
    });
    act(() => {
      useBackgroundTasksStore
        .getState()
        .replace("child-2", [{ id: "dev-server", state: "running" }]);
      useChatStore.getState().addMessage("child-2", reply("m1", REPORT));
      useChatStore.getState().setChatState("child-2", "idle");
    });
    expect(graph().getNode("child-2")?.status).toBe("completed");
    expect(graph().getReport("run-child-2")?.status).toBe("completed");
  });

  it("keeps working while a flock-monitor job it owns runs", async () => {
    vi.useFakeTimers();
    try {
      const { graph, useChatStore, useMonitorJobStore } = await loadModules();
      act(() => {
        graph().registerNode(workerNode("child-3"));
        useChatStore.getState().setChatState("child-3", "streaming");
      });
      act(() => {
        useMonitorJobStore.setState({ liveOwnerIds: new Set(["child-3"]) });
        useChatStore
          .getState()
          .addMessage(
            "child-3",
            reply("m1", "Started the decompile under flock-monitor."),
          );
        useChatStore.getState().setChatState("child-3", "idle");
      });
      expect(graph().getNode("child-3")?.status).toBe("running");

      // The job ends. Its last line is on its way to the agent, so the run
      // is given a moment before it is read as over.
      act(() => {
        useMonitorJobStore.setState({ liveOwnerIds: new Set() });
      });
      expect(graph().getNode("child-3")?.status).toBe("running");

      // Nothing woke the agent: the run settles on what it said.
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(graph().getNode("child-3")?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays stopped when the operator stopped it, whatever still runs", async () => {
    const { graph, useChatStore, useBackgroundTasksStore } =
      await loadModules();
    act(() => {
      graph().registerNode(workerNode("child-4"));
      useChatStore.getState().setChatState("child-4", "streaming");
    });
    act(() => {
      useBackgroundTasksStore
        .getState()
        .replace("child-4", [{ id: "long-job", state: "running" }]);
      useChatStore
        .getState()
        .addMessage("child-4", reply("m1", "Waiting on the long job."));
      useChatStore.getState().setChatState("child-4", "idle");
    });
    expect(graph().getNode("child-4")?.status).toBe("running");
    act(() => {
      graph().patchNode("child-4", { status: "cancelled" });
    });
    expect(graph().getNode("child-4")?.status).toBe("cancelled");
  });
});
