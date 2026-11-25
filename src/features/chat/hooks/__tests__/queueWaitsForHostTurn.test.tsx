import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetForegroundQueueOwnershipForTesting } from "@/features/chat/lib/foregroundQueueOwnership";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { dispatchPrompt } from "@/features/chat/lib/sendCore";
import { clearAdoptedSessionRuns } from "@/features/chat/lib/sessionPromptOwnership";
import {
  acceptHistorySnapshot,
  beginHistorySnapshot,
  handleSessionNotification,
} from "@/features/chat/acp/acpNotificationHandler";
import {
  acpListSessionsPage,
  acpPrepareSessionAccount,
  acpSendMessage,
} from "@/shared/api/acp";
import {
  resetBackgroundQueueDrainStateForTesting,
  useBackgroundQueuedMessageDrain,
} from "../useBackgroundQueuedMessageDrain";
import { useChat } from "../useChat";
import { useMessageQueue } from "../useMessageQueue";

const mocks = vi.hoisted(() => ({
  backgroundSend: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: (...args: unknown[]) => mocks.toastError(...args),
  }),
}));

// The background drain's send, reduced to the dispatch it ends in: the real
// `dispatchPrompt`, so the host's refusal takes the path it takes in the app.
vi.mock("@/features/chat/lib/queuedSessionSend", () => ({
  sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
    mocks.backgroundSend(...args),
}));

vi.mock("@/features/chat/lib/chatExecutorDispatch", async (load) => ({
  ...(await load<typeof import("@/features/chat/lib/chatExecutorDispatch")>()),
  prepareChatExecutorDispatch: vi.fn(async () => undefined),
}));

// Replaced whole: loading the original here would load the session store
// through an import cycle, bound to the real session list.
vi.mock("@/shared/api/acp", () => ({
  acpPrepareSessionAccount: vi.fn(),
  acpSendMessage: vi.fn(),
  acpListSessionsPage: vi.fn(),
  acpCancelSession: vi.fn(async () => true),
  acpCreateSession: vi.fn(),
  acpLoadSession: vi.fn(),
  acpSteerMessage: vi.fn(),
  acpPrepareSession: vi.fn(),
}));

const SESSION = "chat-a";

// What `sessions/prepare_account` answers while the host still runs a turn
// of the chat (src-tauri/.../router/prompts.rs, `invalid_params`).
function hostStillRunsATurn() {
  return {
    code: -32602,
    message: "A prompt is already running for this session",
  };
}

/** The host's word that the chat's turn is over (`run_settled_update`). */
async function hostEndsTheTurn(sessionId = SESSION) {
  await act(async () => {
    await handleSessionNotification({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { activeRunId: null },
      },
    } as never);
  });
}

function queuedRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "queued-1",
    payload: { text: "next task", persona: { kind: "inherit" } },
  };
}

function acceptEveryPrompt() {
  vi.mocked(acpSendMessage).mockImplementation(
    async (_sessionId, _prompt, options) => {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
    },
  );
}

const sentTexts = () =>
  vi.mocked(acpSendMessage).mock.calls.map((call) => call[1]);
const head = () => useChatStore.getState().queuedMessageBySession[SESSION]?.[0];
const runtime = () => useChatStore.getState().getSessionRuntime(SESSION);

function DrainHarness() {
  useBackgroundQueuedMessageDrain();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetForegroundQueueOwnershipForTesting();
  resetBackgroundQueueDrainStateForTesting();
  resetSessionTargetCoordinatorsForTests();
  clearAdoptedSessionRuns();
  vi.mocked(acpPrepareSessionAccount).mockResolvedValue(undefined);
  acceptEveryPrompt();
  mocks.backgroundSend.mockImplementation(
    (
      sessionId: string,
      record: QueuedMessageRecord,
      beforeUserMessageCommitted?: () => void,
      onPromptDispatched?: () => void,
      onPromptWithdrawn?: (error: unknown) => void,
    ) =>
      dispatchPrompt(sessionId, record.payload.text, {
        background: true,
        providerId: "goose",
        beforeUserMessageCommitted,
        onPromptDispatched,
        onPromptWithdrawn,
      }),
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
        id: SESSION,
        title: "Chat A",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 2,
        executionTarget: { harnessId: "goose" },
      },
    ],
    activeSessionId: null,
    activeWorkspaceBySession: {},
    hasHydratedSessions: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a queued message in a chat nobody views, while the host still runs a turn there", () => {
  it("control: a turn the renderer knows of holds the message, which is sent once when it ends", async () => {
    useChatStore.getState().setActiveRunId(SESSION, "run-1");
    useChatStore.setState({
      queuedMessageBySession: { [SESSION]: [queuedRecord()] },
    });
    render(<DrainHarness />);
    await act(async () => Promise.resolve());
    expect(sentTexts()).toEqual([]);

    act(() => useChatStore.getState().settleActiveRun(SESSION));

    await waitFor(() => expect(sentTexts()).toEqual(["next task"]));
    await waitFor(() => expect(head()).toBeUndefined());
  });

  it("is not parked as failed when the host refuses it, waits without polling, and is sent when the host ends the turn (LAWS/CHAT.md)", async () => {
    vi.mocked(acpPrepareSessionAccount).mockRejectedValueOnce(
      hostStillRunsATurn(),
    );
    useChatStore.setState({
      queuedMessageBySession: { [SESSION]: [queuedRecord()] },
    });
    render(<DrainHarness />);
    await waitFor(() =>
      expect(acpPrepareSessionAccount).toHaveBeenCalledTimes(1),
    );
    // Long enough for any retry loop to show itself; there must be none.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    const waiting = {
      headKind: head()?.kind ?? null,
      parkedToast: mocks.toastError.mock.calls.length,
      dispatchAttempts: vi.mocked(acpPrepareSessionAccount).mock.calls.length,
      sent: sentTexts(),
      chatShowsTheRun: runtime().activeRunId !== null,
      chatState: runtime().chatState,
    };
    await hostEndsTheTurn();
    await waitFor(() => expect(sentTexts()).toHaveLength(1), {
      timeout: 500,
    }).catch(() => undefined);

    expect(
      {
        waiting,
        afterTheTurn: { sent: sentTexts(), headKind: head()?.kind ?? null },
      },
      "the refused message stays first, the chat shows the host's turn, and the message goes out when that turn ends",
    ).toEqual({
      waiting: {
        headKind: "transport-ready",
        parkedToast: 0,
        dispatchAttempts: 1,
        sent: [],
        chatShowsTheRun: true,
        chatState: "streaming",
      },
      afterTheTurn: { sent: ["next task"], headKind: null },
    });
  });

  it("is sent at once when the host ended the turn while its refusal was on the way", async () => {
    // The host's settlement reaches the renderer before the refusal it
    // answered just before: the chat must not be left showing a turn that
    // is already over.
    vi.mocked(acpPrepareSessionAccount).mockImplementationOnce(async () => {
      await hostEndsTheTurn();
      throw hostStillRunsATurn();
    });
    useChatStore.setState({
      queuedMessageBySession: { [SESSION]: [queuedRecord()] },
    });
    render(<DrainHarness />);

    await waitFor(() => expect(sentTexts()).toEqual(["next task"]));
    expect({
      dispatchAttempts: vi.mocked(acpPrepareSessionAccount).mock.calls.length,
      activeRunId: runtime().activeRunId,
      chatState: runtime().chatState,
    }).toEqual({ dispatchAttempts: 2, activeRunId: null, chatState: "idle" });
  });
});

describe("the host's run as the session list reports it", () => {
  function listedChat(activeRunId: string | null) {
    vi.mocked(acpListSessionsPage).mockResolvedValue({
      sessions: [
        {
          sessionId: SESSION,
          executionOwner: undefined,
          title: "Chat A",
          updatedAt: "2026-01-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
          lastMessageAt: null,
          archivedAt: null,
          userSetName: false,
          messageCount: 2,
          subtitle: null,
          workingDir: null,
          projectId: null,
          providerId: "goose",
          modelId: null,
          personaId: null,
          activeRunId,
        },
      ],
      nextCursor: null,
      activeComplete: true,
    } as never);
  }

  it("control: a chat the list reports idle sends its queued message at once", async () => {
    listedChat(null);
    await act(() => useChatSessionStore.getState().loadSessions());
    useChatStore.setState({
      queuedMessageBySession: { [SESSION]: [queuedRecord()] },
    });
    render(<DrainHarness />);
    await waitFor(() => expect(sentTexts()).toEqual(["next task"]));
  });

  it("a chat the list reports running is shown running, holds its queued message, and sends it when the host ends the turn", async () => {
    listedChat("run-7");
    await act(() => useChatSessionStore.getState().loadSessions());
    useChatStore.setState({
      queuedMessageBySession: { [SESSION]: [queuedRecord()] },
    });
    render(<DrainHarness />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const whileRunning = {
      attempts: vi.mocked(acpPrepareSessionAccount).mock.calls.length,
      activeRunId: runtime().activeRunId,
      chatState: runtime().chatState,
    };

    await hostEndsTheTurn();
    await waitFor(() => expect(sentTexts()).toHaveLength(1), {
      timeout: 500,
    }).catch(() => undefined);

    expect({ whileRunning, sent: sentTexts() }).toEqual({
      whileRunning: {
        attempts: 0,
        activeRunId: "run-7",
        chatState: "streaming",
      },
      sent: ["next task"],
    });
  });

  it("control: a chat loaded while its turn runs shows the run (the host's update pushed during the load)", async () => {
    beginHistorySnapshot(SESSION);
    await handleSessionNotification({
      sessionId: SESSION,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { activeRunId: "run-9" },
      },
    } as never);
    await act(async () => {
      await acceptHistorySnapshot(SESSION, {
        events: [],
        highWaterEventId: 0,
      } as never);
    });
    expect({
      activeRunId: runtime().activeRunId,
      chatState: runtime().chatState,
    }).toEqual({ activeRunId: "run-9", chatState: "streaming" });
  });
});

describe("the open chat's queue after the host refused it while busy (B-3)", () => {
  // `useChat.sendMessage` resolves false when the dispatch fails before the
  // user turn commits; here the renderer never learns of the host's run
  // until it starts and ends, so every refusal spends the rejection budget.
  async function refuseWhileHostRunsFor(ms: number) {
    vi.useFakeTimers();
    let hostBusy = true;
    const sendMessage = vi.fn(async () => !hostBusy);
    useChatStore.getState().enqueueTransportReadyMessage(SESSION, {
      persona: { kind: "inherit" },
      text: "queued while the host was busy",
    });
    renderHook(() => useMessageQueue(SESSION, "idle", sendMessage));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    const attemptsWhileBusy = sendMessage.mock.calls.length;
    hostBusy = false;
    // The renderer now sees the host run and its end: a real readiness edge.
    await act(async () => {
      useChatStore.getState().setActiveRunId(SESSION, "host-run");
    });
    await act(async () => {
      useChatStore.getState().settleActiveRun(SESSION);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    return {
      attemptsWhileBusy,
      stillQueued:
        useChatStore.getState().queuedMessageBySession[SESSION]?.length ?? 0,
    };
  }

  it("control: a host run shorter than the retry budget, the message is sent when the run ends", async () => {
    const result = await refuseWhileHostRunsFor(3_000);
    expect(result.attemptsWhileBusy).toBeLessThan(5);
    expect(result.stillQueued).toBe(0);
  });

  it("a host run longer than the retry budget: the message is still sent when the session becomes ready (LAWS/CHAT.md)", async () => {
    const result = await refuseWhileHostRunsFor(60_000);
    expect(
      result,
      "after the run ends the queued message must be dispatched again and leave the queue",
    ).toMatchObject({ attemptsWhileBusy: 5, stillQueued: 0 });
  });
});

describe("the open chat's queue while the host still runs a turn", () => {
  function openChat() {
    return renderHook(() => {
      const { sendMessage, chatState } = useChat(SESSION);
      return useMessageQueue(SESSION, chatState, sendMessage);
    });
  }

  it("waits for the host's turn without spending retries and sends when it ends", async () => {
    vi.useFakeTimers();
    vi.mocked(acpPrepareSessionAccount).mockRejectedValueOnce(
      hostStillRunsATurn(),
    );
    useChatStore.getState().enqueueTransportReadyMessage(SESSION, {
      persona: { kind: "inherit" },
      text: "queued while the host was busy",
    });
    openChat();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const attemptsWhileBusy = vi.mocked(acpPrepareSessionAccount).mock.calls
      .length;

    await hostEndsTheTurn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect({
      attemptsWhileBusy,
      sent: sentTexts(),
      stillQueued:
        useChatStore.getState().queuedMessageBySession[SESSION]?.length ?? 0,
      error: runtime().error,
    }).toEqual({
      attemptsWhileBusy: 1,
      sent: ["queued while the host was busy"],
      stillQueued: 0,
      error: null,
    });
  });
});
