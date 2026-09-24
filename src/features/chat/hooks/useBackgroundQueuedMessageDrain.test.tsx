import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import type { SessionDispatchReleaseWaiter } from "@/features/chat/lib/sessionTargetCoordinator";
import {
  registerForegroundQueueOwner,
  resetForegroundQueueOwnershipForTesting,
} from "@/features/chat/lib/foregroundQueueOwnership";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import * as queuePersistence from "@/features/chat/stores/queuePersistence";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import {
  resetBackgroundQueueDrainStateForTesting,
  useBackgroundQueuedMessageDrain,
} from "./useBackgroundQueuedMessageDrain";

const mocks = vi.hoisted(() => ({
  sendQueuedPromptToExistingSessionInBackground: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: (...args: unknown[]) => mocks.toastError(...args),
  }),
}));

vi.mock("@/features/chat/lib/queuedSessionSend", () => ({
  sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
    mocks.sendQueuedPromptToExistingSessionInBackground(...args),
}));

function DrainHarness({
  sessionId,
  ownerReady,
}: {
  sessionId?: string;
  ownerReady?: boolean;
} = {}) {
  useBackgroundQueuedMessageDrain(sessionId, ownerReady);
  return null;
}

function releasedRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "record-1",
    releasedFromDeferred: true,
    payload: {
      text: "held prompt",
      persona: { kind: "persona", id: "persona-1" },
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "notes.txt",
          path: "/tmp/notes.txt",
        },
      ],
      sendOptions: {
        displayText: "Visible prompt",
        assistantPrompt: "Continue",
      },
    },
  };
}

function agentBuilderRecord(): QueuedMessageRecord & {
  kind: "transport-ready";
} {
  return {
    kind: "transport-ready",
    recordId: "agent-builder-record",
    payload: {
      text: "make a reviewer",
      persona: { kind: "inherit" },
      sendOptions: {
        chips: [{ label: "agent-builder", type: "skill" }],
      },
    },
  };
}

function ordinaryRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "ordinary-record",
    payload: {
      text: "ordinary prompt",
      persona: { kind: "inherit" },
    },
  };
}

const DRAFT_SESSION_ID = "draft-session";
const BACKEND_SESSION_ID = "backend-session";

/** A renderer-local chat whose backend session has not been created yet. */
function seedDraftSession(creationState: "pending" | "failed" = "pending") {
  useChatSessionStore.setState((state) => ({
    sessions: [
      {
        id: DRAFT_SESSION_ID,
        title: "New chat",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 0,
        executionTarget: { harnessId: "goose" },
        clientSessionId: DRAFT_SESSION_ID,
        creationState,
      },
      ...state.sessions,
    ],
  }));
}

/** The store writes AppShell makes, in order, when creation completes. */
function promoteDraft() {
  useChatStore
    .getState()
    .promoteSessionId(DRAFT_SESSION_ID, BACKEND_SESSION_ID);
  useChatSessionStore
    .getState()
    .promoteDraftSession(DRAFT_SESSION_ID, BACKEND_SESSION_ID, {});
}

describe("useBackgroundQueuedMessageDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetForegroundQueueOwnershipForTesting();
    resetBackgroundQueueDrainStateForTesting();
    vi.spyOn(queuePersistence, "loadPersistedMessageQueues").mockResolvedValue(
      {},
    );
    mocks.sendQueuedPromptToExistingSessionInBackground.mockResolvedValue(
      undefined,
    );
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
        {
          id: "main-session",
          title: "Main",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
        {
          id: "detached-session",
          title: "Detached",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
  });

  it("waits for session hydration before draining a persisted released head", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });
    useChatSessionStore.setState({ sessions: [], hasHydratedSessions: false });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
    ).toBe(released);

    act(() => {
      useChatSessionStore.setState({
        sessions: [
          {
            id: "session-1",
            title: "Hydrated session",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            messageCount: 0,
            executionTarget: { harnessId: "goose" },
          },
        ],
        hasHydratedSessions: true,
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce();
    });
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).toHaveBeenCalledWith(
      "session-1",
      released,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("keeps a persisted released head when hydration proves the session missing", () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });
    useChatSessionStore.setState({ sessions: [], hasHydratedSessions: false });

    render(<DrainHarness />);
    act(() => {
      useChatSessionStore.setState({ sessions: [], hasHydratedSessions: true });
    });

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
    ).toBe(released);
  });

  it("drains a released deferred payload independently of the Distillctl bridge", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        released,
        expect.any(Function),
        expect.any(Function),
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("commits only the submitted replacement when editing starts during preparation", async () => {
    const released = releasedRecord();
    const committedPayloads: QueuedMessageRecord["payload"][] = [];
    mocks.sendQueuedPromptToExistingSessionInBackground
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _record: QueuedMessageRecord,
          beforeUserMessageCommitted: () => void,
        ) => {
          useChatStore
            .getState()
            .setQueuedMessageEditing("session-1", released.recordId, true);
          beforeUserMessageCommitted();
          committedPayloads.push(released.payload);
        },
      )
      .mockImplementationOnce(
        async (
          _sessionId: string,
          record: QueuedMessageRecord,
          beforeUserMessageCommitted: () => void,
        ) => {
          beforeUserMessageCommitted();
          committedPayloads.push(record.payload);
        },
      );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(committedPayloads).toEqual([]);

    const replacementPayload = {
      ...released.payload,
      text: "submitted replacement",
    };
    act(() => {
      useChatStore
        .getState()
        .updateQueuedMessage(
          "session-1",
          released.recordId,
          replacementPayload,
        );
    });

    await waitFor(() => {
      expect(committedPayloads).toEqual([replacementPayload]);
    });
  });

  it("serializes a synchronous contention release after attempt settlement", async () => {
    const released = releasedRecord();
    const cancel = vi.fn();
    const waiter: SessionDispatchReleaseWaiter = {
      wait: vi.fn((resume) => {
        resume();
        return cancel;
      }),
      cancel,
    };
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(waiter),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
    expect(waiter.wait).toHaveBeenCalledOnce();
  });

  it("parks a failed released payload in a visible terminal state", async () => {
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new Error("preparation rejected"),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        released,
        expect.any(Function),
        expect.any(Function),
      );
    });
    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
      ).toMatchObject({
        kind: "deferred",
        recordId: released.recordId,
        payload: released.payload,
        state: {
          type: "workspace-first-send",
          status: "failed",
          error: expect.any(String),
        },
      });
    });
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Session",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("drains an ordinary queued head when no foreground chat owns the session", async () => {
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("defers an ordinary queued head to a mounted foreground owner", () => {
    const releaseOwner = registerForegroundQueueOwner("session-1");
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    releaseOwner();
  });

  it("keeps excluding a restored head after an incidental load clears the flag", async () => {
    const restored = { ...ordinaryRecord(), restored: true };
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [restored] },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    // Simulate markQueuedMessagesReady from a session load the user did not
    // initiate: the flag clears and a new head object appears.
    act(() => useChatStore.getState().markQueuedMessagesReady("session-1"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });

  it("drains an ordinary queued head after the foreground owner unmounts", async () => {
    const releaseOwner = registerForegroundQueueOwner("session-1");
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => releaseOwner());

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("holds a queued head while its session is still being created, then sends it against the promoted id", async () => {
    seedDraftSession();
    useChatStore.setState({
      queuedMessageBySession: { [DRAFT_SESSION_ID]: [ordinaryRecord()] },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => promoteDraft());

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
    // The draft id is renderer-local; sending against it is the reported bug.
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground.mock.calls.map(
        (call) => call[0],
      ),
    ).toEqual([BACKEND_SESSION_ID]);
  });

  it("keeps an unmounted Agent Builder head parked after promotion until its draft target is prepared", async () => {
    const builder = agentBuilderRecord();
    seedDraftSession();
    useChatStore.setState({
      queuedMessageBySession: { [DRAFT_SESSION_ID]: [builder] },
    });

    render(<DrainHarness />);
    act(() => promoteDraft());

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession[BACKEND_SESSION_ID]?.[0],
    ).toBe(builder);

    const releaseOwner = registerForegroundQueueOwner(BACKEND_SESSION_ID);
    act(() => {
      useChatSessionStore.getState().patchSession(BACKEND_SESSION_ID, {
        intent: "build-agent",
        agentBuilderOpen: true,
        targetAgentPath: "/Users/x/.agents/agents/reviewer.md",
        targetAgentSlug: "reviewer",
      });
    });
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => releaseOwner());

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).toHaveBeenCalledWith(
      BACKEND_SESSION_ID,
      builder,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("leaves a just-promoted head to a foreground owner still keyed to the draft id", async () => {
    const ordinary = ordinaryRecord();
    seedDraftSession();
    useChatStore.setState({
      queuedMessageBySession: { [DRAFT_SESSION_ID]: [ordinary] },
    });
    // The real hand-off timeline: the mounted ChatView owns the draft id and
    // stays registered there until React commits the promoted id, which is
    // after the synchronous store writes below. Claiming the head in that
    // window makes this drain's hydration race the foreground send.
    const releaseOwner = registerForegroundQueueOwner(DRAFT_SESSION_ID);

    render(<DrainHarness />);
    act(() => promoteDraft());

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession[BACKEND_SESSION_ID]?.[0],
    ).toBe(ordinary);

    // The user leaves before the foreground drain sends it: this drain takes
    // over, against the promoted id.
    act(() => releaseOwner());

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        BACKEND_SESSION_ID,
        ordinary,
        expect.any(Function),
        expect.any(Function),
      ),
    );
  });
});
