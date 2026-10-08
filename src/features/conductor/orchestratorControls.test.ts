import { beforeEach, describe, expect, it, vi } from "vitest";

import { admitSystemInheritedQueuedMessage } from "@/features/chat/lib/admittedSend";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { observeExecutionOwner } from "@/features/chat/lib/executionOwnership";
import type { OwnedTaskDispatch } from "@/features/benchmarks/lib/ownedTaskExecution";

const acpCancelSession = vi.hoisted(() =>
  vi.fn<() => Promise<void>>(async () => undefined),
);
vi.mock("@/shared/api/acp", () => ({ acpCancelSession }));
const ownedStatus = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<OwnedTaskDispatch | null>>(),
);
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", () => ({
  ownedTaskExecution: { status: ownedStatus },
}));

const { stopOrchestratorSession } = await import("./orchestratorControls");
const { useConductorGraphStore } = await import("./conductorGraphStore");

const CHILD_ID = "child-0";

function registerChild(sessionId = CHILD_ID): void {
  useConductorGraphStore.getState().registerNode({
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: "run-0",
    harnessId: "goose",
    displayName: "Scout",
    status: "starting",
    waveId: "wave-1",
    stepIndex: 0,
  });
}

function queueFirstPrompt(sessionId = CHILD_ID): void {
  useChatStore.getState().enqueueTransportReadyMessage(
    sessionId,
    admitSystemInheritedQueuedMessage({
      text: "Find every caller",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" },
      },
    }),
  );
}

function queueFor(sessionId: string) {
  return useChatStore.getState().queuedMessageBySession[sessionId] ?? [];
}

describe("stopOrchestratorSession", () => {
  beforeEach(() => {
    acpCancelSession.mockReset().mockResolvedValue(undefined);
    ownedStatus.mockReset();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({
      queuedMessageBySession: {},
      messagesBySession: {},
      sessionStateById: {},
    });
  });

  it("drops the child's queued first prompt instead of leaving it to drain", async () => {
    // A wave child's first prompt is queued, and the cross-session drain sends
    // it as soon as the session reports idle — which this stop itself does. A
    // stop that left the record behind produced an executor that started work
    // a moment after being stopped, with its wave step already terminal: no
    // digest, no budget, no stop control.
    registerChild();
    queueFirstPrompt();
    expect(queueFor(CHILD_ID)).toHaveLength(1);

    await stopOrchestratorSession(CHILD_ID);

    expect(queueFor(CHILD_ID)).toHaveLength(0);
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)?.status).toBe(
      "cancelled",
    );
    expect(acpCancelSession).toHaveBeenCalledWith(CHILD_ID);
  });

  it("still cancels the turn when the cancel call rejects", async () => {
    registerChild();
    queueFirstPrompt();
    acpCancelSession.mockRejectedValueOnce(new Error("already finished"));

    await expect(stopOrchestratorSession(CHILD_ID)).resolves.toBeUndefined();
    expect(queueFor(CHILD_ID)).toHaveLength(0);
  });

  it("dismisses queued future work without cancelling a completed ordinary run", async () => {
    registerChild();
    useConductorGraphStore
      .getState()
      .patchNode(CHILD_ID, { status: "completed" });
    queueFirstPrompt();
    await stopOrchestratorSession(CHILD_ID);
    expect(queueFor(CHILD_ID)).toHaveLength(0);
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)?.status).toBe(
      "completed",
    );
    expect(acpCancelSession).not.toHaveBeenCalled();
  });

  function ownedChild(name: string): OwnedTaskDispatch {
    const sessionId = `owned-stop-${name}`;
    registerChild(sessionId);
    useConductorGraphStore.getState().patchNode(sessionId, {
      runId: `owned-task:${name}`,
      status: "running",
    });
    observeExecutionOwner(sessionId, { kind: "task", id: `task:${name}` });
    return {
      requestKey: `owned-task:${name}`,
      sessionId,
      runId: `native-${name}`,
      userMessageId: `user-${name}`,
      phase: "running",
      eventCursor: 1,
      result: null,
      error: null,
    };
  }

  it("late cleanup preserves a completed native task even if the graph is stale", async () => {
    const status = ownedChild("completed");
    ownedStatus.mockResolvedValue({ ...status, phase: "terminal" });
    queueFirstPrompt(status.sessionId);
    await stopOrchestratorSession(status.sessionId);
    expect(ownedStatus).toHaveBeenCalledWith("completed");
    expect(acpCancelSession).not.toHaveBeenCalled();
    expect(queueFor(status.sessionId)).toHaveLength(0);
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("completed");
  });

  it("keeps an active owned cancellation pending until native terminal acknowledgement", async () => {
    const status = ownedChild("active");
    ownedStatus.mockResolvedValueOnce(status).mockResolvedValueOnce({
      ...status,
      phase: "terminal",
      error: { kind: "cancelled", message: "Native cancellation confirmed" },
    });
    let acknowledge!: () => void;
    acpCancelSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    queueFirstPrompt(status.sessionId);
    const stopping = stopOrchestratorSession(status.sessionId);
    await vi.waitFor(() =>
      expect(acpCancelSession).toHaveBeenCalledWith(status.sessionId),
    );
    expect(queueFor(status.sessionId)).toHaveLength(0);
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("running");
    expect(
      useChatStore.getState().sessionStateById[status.sessionId]
        ?.isRunCancellationPending,
    ).toBe(true);
    acknowledge();
    await stopping;
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("cancelled");
    expect(
      useChatStore.getState().sessionStateById[status.sessionId]
        ?.isRunCancellationPending,
    ).toBe(false);
  });

  it("preserves native completion that wins the active cancellation race", async () => {
    const status = ownedChild("completion-race");
    ownedStatus
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, phase: "terminal" });
    await stopOrchestratorSession(status.sessionId);
    expect(acpCancelSession).toHaveBeenCalledWith(status.sessionId);
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("completed");
  });

  it("surfaces unresolved owned cancellation without inventing a terminal graph outcome", async () => {
    const status = ownedChild("unknown");
    ownedStatus.mockResolvedValueOnce(status);
    acpCancelSession.mockRejectedValueOnce(
      new Error("Native cancellation unknown"),
    );
    await expect(stopOrchestratorSession(status.sessionId)).rejects.toThrow(
      "Native cancellation unknown",
    );
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("running");
    expect(
      useChatStore.getState().sessionStateById[status.sessionId]?.error,
    ).toContain("Native cancellation unknown");
    expect(
      useChatStore.getState().sessionStateById[status.sessionId]
        ?.isRunCancellationPending,
    ).toBe(true);
  });
  it("still stops an active turn when an ordinary node describes an earlier completed run", async () => {
    registerChild();
    useConductorGraphStore
      .getState()
      .patchNode(CHILD_ID, { status: "completed" });
    useChatStore.getState().setChatState(CHILD_ID, "streaming");
    queueFirstPrompt();
    await stopOrchestratorSession(CHILD_ID);
    expect(acpCancelSession).toHaveBeenCalledWith(CHILD_ID);
    expect(queueFor(CHILD_ID)).toHaveLength(0);
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)?.status).toBe(
      "completed",
    );
  });

  it("does not settle an owned stop while the native dispatch remains running", async () => {
    const status = ownedChild("not-acknowledged");
    ownedStatus.mockResolvedValue(status);
    await expect(stopOrchestratorSession(status.sessionId)).rejects.toThrow(
      "no terminal acknowledgement",
    );
    expect(acpCancelSession).toHaveBeenCalledWith(status.sessionId);
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("running");
    expect(
      useChatStore.getState().sessionStateById[status.sessionId]
        ?.isRunCancellationPending,
    ).toBe(true);
  });

  it("attempts real orphan cancellation when the initial native status read is unavailable", async () => {
    const status = ownedChild("read-unavailable");
    ownedStatus
      .mockRejectedValueOnce(new Error("Temporary IPC failure"))
      .mockResolvedValueOnce({
        ...status,
        phase: "terminal",
        error: { kind: "cancelled" },
      });
    await stopOrchestratorSession(status.sessionId);
    expect(acpCancelSession).toHaveBeenCalledWith(status.sessionId);
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("cancelled");
  });

  it("refuses a different native child receipt without cancelling or relabelling it", async () => {
    const status = ownedChild("wrong-receipt");
    ownedStatus.mockResolvedValue({
      ...status,
      requestKey: "owned-task:someone-else",
      phase: "terminal",
    });
    await expect(stopOrchestratorSession(status.sessionId)).rejects.toThrow(
      "another child run",
    );
    expect(acpCancelSession).not.toHaveBeenCalled();
    expect(
      useConductorGraphStore.getState().getNode(status.sessionId)?.status,
    ).toBe("running");
  });
});
