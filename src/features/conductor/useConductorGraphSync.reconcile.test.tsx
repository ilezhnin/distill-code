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

function staleNode(sessionId: string): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${sessionId}`,
    harnessId: "goose",
    displayName: sessionId,
    status: "running",
    createdAt: 1,
  };
}

/**
 * The reconcile guard is module-level, so every case re-imports the hook and its
 * stores with a fresh module registry.
 */
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

describe("useConductorGraphSync startup reconcile", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("stops a stale child once both hydration flags are already true on mount", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();
    useConductorGraphStore.getState().registerNode(staleNode("worker-1"));
    useChatStore.setState({ hasHydratedMessageQueues: true });
    useChatSessionStore.setState({ hasHydratedSessions: true });

    renderHook(() => useConductorGraphSync());

    expect(useConductorGraphStore.getState().getNode("worker-1")?.status).toBe(
      "stopped",
    );
  });

  it("waits for hydration and then stops the stale child", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();
    useConductorGraphStore.getState().registerNode(staleNode("worker-1"));

    renderHook(() => useConductorGraphSync());
    expect(useConductorGraphStore.getState().getNode("worker-1")?.status).toBe(
      "running",
    );

    act(() => {
      useChatStore.setState({ hasHydratedMessageQueues: true });
    });
    expect(useConductorGraphStore.getState().getNode("worker-1")?.status).toBe(
      "running",
    );

    act(() => {
      useChatSessionStore.setState({ hasHydratedSessions: true });
    });
    expect(useConductorGraphStore.getState().getNode("worker-1")?.status).toBe(
      "stopped",
    );
  });

  it("does not re-stomp a node that goes back to work later in the session", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();
    useConductorGraphStore.getState().registerNode(staleNode("worker-1"));
    useChatStore.setState({ hasHydratedMessageQueues: true });
    useChatSessionStore.setState({ hasHydratedSessions: true });

    const { unmount } = renderHook(() => useConductorGraphSync());
    expect(useConductorGraphStore.getState().getNode("worker-1")?.status).toBe(
      "stopped",
    );

    // A later restart of the same child: the one-shot pass must stay retired,
    // even across a remount of the hook.
    unmount();
    useConductorGraphStore
      .getState()
      .patchNode("worker-1", { status: "running" });
    renderHook(() => useConductorGraphSync());
    act(() => {
      useChatStore.setState({ isConnected: true });
    });

    expect(useConductorGraphStore.getState().getNode("worker-1")?.status).toBe(
      "running",
    );
  });

  it("does not stamp a promoted conductor with its role name", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatSessionStore,
    } = await loadModules();
    const { updateSessionTitle } = await import(
      "@/features/chat/stores/chatSessionOperations"
    );
    useConductorGraphStore.getState().registerNode({
      sessionId: "draft-1",
      projectId: "project",
      role: "conductor",
      managedBy: "ui",
      parentSessionId: null,
      rootConductorId: "draft-1",
      runId: null,
      harnessId: "goose",
      displayName: "Producer",
      status: "stopped",
      createdAt: 1,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "goose-1",
          clientSessionId: "draft-1",
          title: "Producer",
          userSetName: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      hasHydratedSessions: true,
    });

    renderHook(() => useConductorGraphSync());

    expect(updateSessionTitle).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().getSession("goose-1")).toMatchObject({
      title: "Producer",
      userSetName: false,
    });
    expect(useConductorGraphStore.getState().getNode("goose-1")?.role).toBe(
      "conductor",
    );
    expect(
      useConductorGraphStore.getState().getNode("draft-1"),
    ).toBeUndefined();
  });

  it("copies a generated chat title onto the conductor graph label", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatSessionStore,
    } = await loadModules();
    useConductorGraphStore.getState().registerNode({
      sessionId: "goose-1",
      projectId: "project",
      role: "conductor",
      managedBy: "ui",
      parentSessionId: null,
      rootConductorId: "goose-1",
      runId: null,
      harnessId: "goose",
      displayName: "Producer",
      status: "stopped",
      createdAt: 1,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "goose-1",
          title: "Refund timeout fix",
          userSetName: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
      hasHydratedSessions: true,
    });

    renderHook(() => useConductorGraphSync());

    expect(
      useConductorGraphStore.getState().getNode("goose-1")?.displayName,
    ).toBe("Refund timeout fix");
  });
});
