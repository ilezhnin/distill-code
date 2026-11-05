import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionNode } from "./types";

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => {}),
}));

function childNode(sessionId: string): SessionNode {
  return {
    sessionId,
    projectId: "invented-project",
    role: "worker",
    managedBy: "agent-cli",
    parentSessionId: "parent-chat",
    rootConductorId: "parent-chat",
    runId: `run-${sessionId}`,
    harnessId: "codex-acp",
    displayName: "Recovery worker",
    status: "starting",
    createdAt: 1,
  };
}

/** The sync pass keeps module-level memory, so each case starts fresh. */
async function loadModules() {
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
  return {
    useConductorGraphSync,
    useConductorGraphStore,
    useChatStore,
    useChatSessionStore,
  };
}

describe("an agent whose first message the provider refused as rate-limited", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("waits for the provider instead of reading as finished or failed", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();
    useChatStore.setState({ hasHydratedMessageQueues: true });
    useChatSessionStore.setState({ hasHydratedSessions: true });
    renderHook(() => useConductorGraphSync());
    const graph = () => useConductorGraphStore.getState();
    const status = () => graph().getNode("child-1")?.status;
    act(() => {
      graph().registerNode(childNode("child-1"));
    });

    // The first prompt goes out...
    act(() => {
      useChatStore.getState().setChatState("child-1", "thinking");
    });
    expect(status()).toBe("running");

    // ...and comes back refused with a 429 before the turn began: the queue
    // parks it on a wait, then the chat goes idle.
    act(() => {
      useChatStore
        .getState()
        .setAccountQuotaWaitUntil("child-1", Date.now() + 15_000);
      useChatStore.getState().setChatState("child-1", "idle");
    });
    expect(status()).toBe("waiting");
    expect(graph().getReport("run-child-1")).toBeUndefined();

    // The wait is over and the queue is about to send it again: still not a
    // finished run.
    act(() => {
      useChatStore.getState().setAccountQuotaWaitUntil("child-1", null);
    });
    expect(status()).toBe("waiting");
    expect(graph().getReport("run-child-1")).toBeUndefined();

    // The second try runs.
    act(() => {
      useChatStore.getState().setChatState("child-1", "streaming");
    });
    expect(status()).toBe("running");
  });

  it("stays stopped once the operator stopped it while it waited", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();
    useChatStore.setState({ hasHydratedMessageQueues: true });
    useChatSessionStore.setState({ hasHydratedSessions: true });
    renderHook(() => useConductorGraphSync());
    const graph = () => useConductorGraphStore.getState();
    act(() => {
      graph().registerNode(childNode("child-2"));
      useChatStore
        .getState()
        .setAccountQuotaWaitUntil("child-2", Date.now() + 15_000);
    });
    expect(graph().getNode("child-2")?.status).toBe("waiting");

    act(() => {
      graph().patchNode("child-2", { status: "cancelled" });
    });
    expect(graph().getNode("child-2")?.status).toBe("cancelled");
  });
});
