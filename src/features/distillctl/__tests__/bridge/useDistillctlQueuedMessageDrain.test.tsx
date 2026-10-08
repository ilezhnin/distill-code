import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import type { SessionDispatchReleaseWaiter } from "@/features/chat/lib/sessionTargetCoordinator";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useDistillctlQueuedMessageDrain } from "@/features/distillctl/bridge/useDistillctlQueuedMessageDrain";
import { createUserMessage } from "@/shared/types/messages";
import {
  clearAccountQuotaWait,
  deferForAccountQuota,
} from "@/features/chat/lib/accountQuotaWait";

const mocks = vi.hoisted(() => ({
  sendPromptToExistingSessionInBackground: vi.fn(),
  sendQueuedPromptToExistingSessionInBackground: vi.fn(),
}));

vi.mock(
  "@/features/distillctl/commands/runtime/sessionSend",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/distillctl/commands/runtime/sessionSend")
      >();
    return {
      ...actual,
      sendPromptToExistingSessionInBackground: (...args: unknown[]) =>
        mocks.sendPromptToExistingSessionInBackground(...args),
      sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
        mocks.sendQueuedPromptToExistingSessionInBackground(...args),
    };
  },
);

function DrainHarness({
  sessionId,
  ownerReady,
}: {
  sessionId?: string;
  ownerReady?: boolean;
}) {
  useDistillctlQueuedMessageDrain(sessionId, ownerReady);
  return null;
}

function resetChatStore(): void {
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    hasHydratedMessageQueues: true,
    draftsBySession: {},
    skillDraftsBySession: {},
    activeSessionId: null,
    isViewingActiveSession: false,
    isConnected: false,
    loadingSessionIds: new Set(),
    scrollTargetMessageBySession: {},
  });
}

function expectedDispatchOptions(
  executorRequestKey: unknown = expect.stringMatching(/^chat:/),
) {
  return {
    returnOnDispatch: true,
    onPromptNotAccepted: expect.any(Function),
    sendOptions: {
      executorRequestKey,
      userMessageMetadata: { origin: "distillctl_cross_session" },
      acpPromptMetadata: { origin: "distillctl_cross_session" },
    },
  };
}

describe("useDistillctlQueuedMessageDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendPromptToExistingSessionInBackground.mockResolvedValue(undefined);
    mocks.sendQueuedPromptToExistingSessionInBackground.mockResolvedValue(
      undefined,
    );
    resetChatStore();
    useChatSessionStore.setState({
      sessions: [
        "session-1",
        "other-session",
        "main-session",
        "detached-session",
        "owned-session",
      ].map((id) => ({
        id,
        title: "Session",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 0,
        executionTarget: { harnessId: "claude-acp" },
      })),
      hasHydratedSessions: true,
    });
  });

  afterEach(() => {
    clearAccountQuotaWait("session-1");
    vi.restoreAllMocks();
  });

  it("keeps a quota-deferred cross-session message ready for its reset instead of parking it as failed", async () => {
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "cross-session task",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" },
      },
    });
    const original =
      useChatStore.getState().queuedMessageBySession["session-1"][0];
    mocks.sendPromptToExistingSessionInBackground.mockImplementationOnce(() => {
      const error = {
        data: { kind: "account_quota_wait", promptNotAccepted: true },
      };
      deferForAccountQuota("session-1", error);
      return Promise.reject(error);
    });
    const view = render(<DrainHarness />);
    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1),
    );
    expect(useChatStore.getState().queuedMessageBySession["session-1"][0]).toBe(
      original,
    );
    expect(original.kind).toBe("transport-ready");
    view.unmount();
  });

  it("restores the same delivery after an optimistic dispatch was proven unaccepted", async () => {
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "cross-session task",
      sendOptions: {
        userMessageMetadata: {
          origin: "distillctl_cross_session",
          distillDeliveryId: "once",
        },
      },
    });
    const original =
      useChatStore.getState().queuedMessageBySession["session-1"][0];
    let rollback: (() => void) | undefined;
    mocks.sendPromptToExistingSessionInBackground.mockImplementationOnce(
      (
        _sessionId: string,
        _text: string,
        _before: unknown,
        options: { onPromptNotAccepted(): void },
      ) => {
        rollback = options.onPromptNotAccepted;
        useChatStore.getState().setChatState("session-1", "streaming");
        return Promise.resolve();
      },
    );
    const view = render(<DrainHarness />);
    await waitFor(() =>
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined(),
    );
    act(() => {
      deferForAccountQuota("session-1", {
        data: { kind: "account_quota_wait", promptNotAccepted: true },
      });
      useChatStore.getState().setChatState("session-1", "idle");
      rollback?.();
    });
    expect(useChatStore.getState().queuedMessageBySession["session-1"][0]).toBe(
      original,
    );
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledTimes(
      1,
    );
    view.unmount();
  });

  it("keeps a rejected delivery when rollback arrives before dispatch acknowledgment", async () => {
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "rollback before acknowledgment",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" },
      },
    });
    const original =
      useChatStore.getState().queuedMessageBySession["session-1"][0];
    mocks.sendPromptToExistingSessionInBackground.mockImplementationOnce(
      (
        _sessionId: string,
        _text: string,
        _before: unknown,
        options: { onPromptNotAccepted(): void },
      ) => {
        deferForAccountQuota("session-1", {
          data: { kind: "account_quota_wait", promptNotAccepted: true },
        });
        options.onPromptNotAccepted();
        return Promise.resolve();
      },
    );
    const view = render(<DrainHarness />);
    await act(async () => Promise.resolve());
    expect(useChatStore.getState().queuedMessageBySession["session-1"][0]).toBe(
      original,
    );
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledTimes(
      1,
    );
    view.unmount();
  });

  it("serializes a synchronous contention release after attempt settlement", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "claude-acp" },
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });
    const cancel = vi.fn();
    const waiter: SessionDispatchReleaseWaiter = {
      wait: vi.fn((resume) => {
        resume();
        return cancel;
      }),
      cancel,
    };
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(waiter),
    );

    render(<DrainHarness />);

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
    expect(waiter.wait).toHaveBeenCalledOnce();
    const attempts = mocks.sendPromptToExistingSessionInBackground.mock.calls;
    expect(attempts[0][3].sendOptions.executorRequestKey).toMatch(/^chat:/);
    expect(attempts[1][3].sendOptions.executorRequestKey).toBe(
      attempts[0][3].sendOptions.executorRequestKey,
    );
  });

  it("waits for session-list hydration before draining restored distillctl queues", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "restored prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });
    useChatSessionStore.setState({ hasHydratedSessions: false });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => useChatSessionStore.setState({ hasHydratedSessions: true }));

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "restored prompt",
        expect.any(Function),
        expectedDispatchOptions(),
      );
    });
  });

  it("dismisses a stale queued delivery already accepted in the transcript", async () => {
    const accepted = createUserMessage("queued delivery");
    accepted.metadata = {
      origin: "distillctl_cross_session",
      distillDeliveryId: "monitor-event-1",
    };
    const chatStore = useChatStore.getState();
    chatStore.addMessage("session-1", accepted);
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued delivery",
      sendOptions: {
        userMessageMetadata: {
          origin: "distillctl_cross_session" as const,
          distillDeliveryId: "monitor-event-1",
        },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
  });

  it("drains consecutive distillctl records in FIFO order while idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "first prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "second prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });
    const [first, second] =
      useChatStore.getState().queuedMessageBySession["session-1"];

    render(<DrainHarness />);

    await waitFor(() => {
      expect(mocks.sendPromptToExistingSessionInBackground.mock.calls).toEqual([
        [
          "session-1",
          "first prompt",
          expect.any(Function),
          expectedDispatchOptions(first.payload.executorRequestKey),
        ],
        [
          "session-1",
          "second prompt",
          expect.any(Function),
          expectedDispatchOptions(second.payload.executorRequestKey),
        ],
      ]);
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("keeps distillctl-origin queued messages when the background send fails", async () => {
    const sendError = new Error("prepare failed");
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      sendError,
    );
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
        acpPromptMetadata: { origin: "distillctl_cross_session" },
      },
    });
    const original =
      useChatStore.getState().queuedMessageBySession["session-1"][0];
    expect(original.payload.executorRequestKey).toMatch(/^chat:/);
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "queued prompt",
        expect.any(Function),
        expectedDispatchOptions(original.payload.executorRequestKey),
      );
    });
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[distillctl-queue] failed to send queued prompt for session session-1",
        sendError,
      );
    });
    const head =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0];
    expect(head?.payload).toEqual({
      executorRequestKey: original.payload.executorRequestKey,
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
        acpPromptMetadata: { origin: "distillctl_cross_session" },
      },
    });
    expect(head?.payload).toBe(original.payload);
    // Parked as failed, so neither this run nor the next start retries it.
    expect(head).toMatchObject({
      kind: "deferred",
      state: { status: "failed" },
    });
  });

  it("waits for authoritative queue hydration before draining cached records", async () => {
    const cached: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "cached-record",
      payload: {
        persona: { kind: "inherit" },
        text: "cached prompt",
        sendOptions: {
          userMessageMetadata: { origin: "distillctl_cross_session" as const },
        },
      },
    };
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [cached] },
      hasHydratedMessageQueues: false,
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().replaceQueuedMessages({
        "session-1": [cached],
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledWith(
      "session-1",
      "cached prompt",
      expect.any(Function),
      expectedDispatchOptions("chat:session-1:queue:cached-record"),
    );
  });

  it("waits until a detached window owns the session before scoped draining", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("owned-session", "streaming");
    chatStore.enqueueTransportReadyMessage("owned-session", {
      persona: { kind: "inherit" },
      text: "queued while source runs",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });
    const { rerender } = render(
      <DrainHarness sessionId="owned-session" ownerReady={false} />,
    );

    act(() => {
      useChatStore.setState({
        sessionStateById: {},
        hasHydratedMessageQueues: true,
      });
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    rerender(<DrainHarness sessionId="owned-session" ownerReady />);

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "owned-session",
        "queued while source runs",
        expect.any(Function),
        expectedDispatchOptions(),
      );
    });
  });

  it("retains and retries when a run starts during background preparation", async () => {
    mocks.sendPromptToExistingSessionInBackground
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _prompt: string,
          beforeUserMessageCommitted: () => void,
        ) => {
          useChatStore.getState().setActiveRunId("session-1", "racing-run");
          beforeUserMessageCommitted();
        },
      )
      .mockResolvedValueOnce(undefined);
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "race-safe prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("race-safe prompt");

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", null);
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
  });

  it("dismisses at acknowledged dispatch while the held turn fences a replacement", async () => {
    let settleTurn!: () => void;
    const heldSettlement = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });
    mocks.sendPromptToExistingSessionInBackground.mockImplementation(
      async (
        _sessionId: string,
        _prompt: string,
        beforeUserMessageCommitted: () => void,
        options?: { returnOnDispatch?: boolean },
      ) => {
        expect(options).toEqual(expectedDispatchOptions());
        beforeUserMessageCommitted();
        useChatStore.getState().setActiveRunId("session-1", "held-turn");
        // Match the real helper's split contract: queue ownership completes
        // now while the detached turn keeps the runtime blocked until settlement.
        void heldSettlement.then(() => {
          useChatStore.getState().setActiveRunId("session-1", null);
        });
      },
    );
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledTimes(
      1,
    );

    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("session-1", {
        persona: { kind: "inherit" },
        text: "replacement prompt",
        sendOptions: {
          userMessageMetadata: { origin: "distillctl_cross_session" as const },
        },
      });
    });
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledTimes(
      1,
    );
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("replacement prompt");

    act(() => {
      settleTurn();
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenLastCalledWith(
        "session-1",
        "replacement prompt",
        expect.any(Function),
        expectedDispatchOptions(),
      );
    });
  });

  it("retains an edited replacement when an older background send resolves", async () => {
    let resolveSend!: () => void;
    mocks.sendPromptToExistingSessionInBackground.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
    );
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
        ?.recordId;
    expect(recordId).toBeDefined();
    if (!recordId) throw new Error("expected queued record fixture");
    render(<DrainHarness />);
    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "original prompt",
        expect.any(Function),
        expectedDispatchOptions(),
      );
    });

    act(() => {
      expect(
        useChatStore
          .getState()
          .setQueuedMessageEditing("session-1", recordId, true),
      ).toBe(true);
      expect(
        useChatStore.getState().updateQueuedMessage("session-1", recordId, {
          persona: { kind: "inherit" },
          text: "replacement prompt",
          sendOptions: {
            userMessageMetadata: {
              origin: "distillctl_cross_session" as const,
            },
          },
        }),
      ).toBe(true);
      resolveSend();
    });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
          ?.payload.text,
      ).toBe("replacement prompt");
    });
  });

  it("holds a Distillctl head while its session is still being created", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          title: "New chat",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "claude-acp" },
          clientSessionId: "draft-session",
          creationState: "pending" as const,
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("draft-session", {
      persona: { kind: "inherit" },
      text: "cross-session prompt",
      sendOptions: {
        userMessageMetadata: { origin: "distillctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session", {});
    });

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      mocks.sendPromptToExistingSessionInBackground.mock.calls.map(
        (call) => call[0],
      ),
    ).toEqual(["backend-session"]);
  });
});
