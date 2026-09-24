import { beforeEach, describe, expect, it, vi } from "vitest";

import { admitSystemInheritedQueuedMessage } from "@/features/chat/lib/admittedSend";
import { useChatStore } from "@/features/chat/stores/chatStore";

const acpCancelSession = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/shared/api/acp", () => ({ acpCancelSession }));

const { stopOrchestratorSession } = await import("./orchestratorControls");
const { useConductorGraphStore } = await import("./conductorGraphStore");

const CHILD_ID = "child-0";

function registerChild(): void {
  useConductorGraphStore.getState().registerNode({
    sessionId: CHILD_ID,
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

function queueFirstPrompt(): void {
  useChatStore.getState().enqueueTransportReadyMessage(
    CHILD_ID,
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
    acpCancelSession.mockClear();
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
});
