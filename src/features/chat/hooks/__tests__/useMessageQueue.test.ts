import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "@/shared/types/chat";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import {
  executorSelection,
  type ApplicationExecutorRequest,
  type ExecutorDecision,
} from "@/features/benchmarks/lib/executorSelection";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { QueuedMessageOwnershipLostError } from "../../lib/preCommitSendRejection";
import { beginModelSelectionIntent } from "../../model-selection/modelSelectionIntent";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "../../lib/sessionTargetCoordinator";
import type { ChatSendOptions } from "../../types";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useMessageQueue } from "../useMessageQueue";
import {
  clearAccountQuotaWait,
  deferForAccountQuota,
} from "../../lib/accountQuotaWait";

const mockAcpPrepareSession = vi.fn().mockResolvedValue(undefined);
vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection: { get: vi.fn(), select: vi.fn(), prepare: vi.fn() },
}));

vi.mock("@/shared/api/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/acp")>()),
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function initialDecision(
  request: ApplicationExecutorRequest,
): ExecutorDecision {
  return {
    request: {
      requestKey: request.requestKey,
      surface: "chat",
      contextId: request.contextId,
      prediction: {
        task: request.task,
        targetFamily: request.targetFamily,
        targetGroup: request.targetGroup,
        candidates: request.candidates,
        hardCandidateKey: null,
        minQuality: 0,
      },
      priorKeys: [],
      modelId: null,
    },
    chosen: request.candidates[0].configuration,
    chosenKey: "native-key",
    source: "learned",
    reason: "certified",
    inputHash: "input",
    artifactHash: "artifact",
    createdAt: 1,
    policyVersion: "test",
    learnedStatus: "active",
    researchPrediction: null,
    learnedDispatchAllowed: true,
  };
}

describe("useMessageQueue", () => {
  beforeEach(() => {
    vi.mocked(executorSelection.get).mockReset().mockResolvedValue(null);
    vi.mocked(executorSelection.select).mockReset();
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s1",
          title: "Chat",
          executionTarget: { harnessId: "goose" },
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("holds FIFO through first-task selection and does not duplicate dispatch when the foreground remounts", async () => {
    const selected = {
      target: {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "task-model",
        modelName: "Task model",
      },
      runSettings: { effort: "low" },
    };
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "codex-acp",
          {
            providerId: "codex-acp",
            fetchedAt: Date.now(),
            models: [
              { id: "task-model", name: "Task model", providerId: "codex-acp" },
            ],
          },
        ],
      ]),
    });
    const selecting = deferred<ExecutorDecision>();
    let request: ApplicationExecutorRequest | undefined;
    vi.mocked(executorSelection.select).mockImplementation((input) => {
      request = input;
      return selecting.promise;
    });
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      text: "first accepted task",
      persona: { kind: "none" },
      sendOptions: {
        initialExecutorIntent: {
          options: [selected],
          priorIds: [],
          roleId: null,
          rolePrompt: "",
          workClassId: "general",
        },
      },
    });
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      text: "second accepted task",
      persona: { kind: "none" },
    });
    const sending = deferred<boolean>();
    const sendMessage = vi.fn(
      (_text, _persona, _attachments, options: ChatSendOptions = {}) => {
        options.beforeUserMessageCommitted?.();
        options.onUserMessageCommitted?.();
        useChatSessionStore.getState().patchSession("s1", { messageCount: 1 });
        useChatStore.getState().setChatState("s1", "streaming");
        return sending.promise;
      },
    );
    const first = renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await waitFor(() =>
      expect(executorSelection.select).toHaveBeenCalledTimes(1),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    first.unmount();
    const second = renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    if (!request) throw new Error("Missing initial selection");
    const prepared: ExecutorDecision = {
      request: {
        requestKey: request.requestKey,
        surface: "chat",
        contextId: "s1",
        prediction: {
          task: request.task,
          targetFamily: request.targetFamily,
          targetGroup: request.targetGroup,
          candidates: request.candidates,
          hardCandidateKey: null,
          minQuality: 0,
        },
        priorKeys: [],
        modelId: null,
      },
      chosen: request.candidates[0].configuration,
      chosenKey: "native-key",
      source: "learned",
      reason: "certified",
      inputHash: "input",
      artifactHash: "artifact",
      createdAt: 1,
      policyVersion: "test",
      learnedStatus: "active",
      researchPrediction: null,
      learnedDispatchAllowed: true,
    };
    await act(async () => selecting.resolve(prepared));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0][0]).toBe("first accepted task");
    expect(sendMessage.mock.calls[0][3]?.sessionSelection).toMatchObject(
      selected.target,
    );
    expect(executorSelection.select).toHaveBeenCalledTimes(1);
    await act(async () => sending.resolve(true));
    act(() => useChatStore.getState().setChatState("s1", "idle"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1][0]).toBe("second accepted task");
    second.unmount();
  });

  it("retains the original head across repeated quota deferrals without exhausting rejection retries", () => {
    let waiting = true;
    const sendMessage = vi.fn(() => {
      if (!waiting) return true;
      deferForAccountQuota("s1", {
        data: { kind: "account_quota_wait", promptNotAccepted: true },
      });
      return false;
    });
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      text: "keep exact intent",
      persona: { kind: "none" },
    });
    const original = useChatStore.getState().queuedMessageBySession.s1[0];
    const hook = renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= 8; attempt++) {
      act(() => clearAccountQuotaWait("s1"));
      expect(sendMessage).toHaveBeenCalledTimes(attempt);
      expect(useChatStore.getState().queuedMessageBySession.s1[0]).toBe(
        original,
      );
    }
    waiting = false;
    act(() => clearAccountQuotaWait("s1"));
    expect(sendMessage).toHaveBeenCalledTimes(9);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
    hook.unmount();
  });

  it("does not resume an old session's accepted task through a new session's callback", async () => {
    const target = {
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "task-model",
      modelName: "Task model",
    };
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "codex-acp",
          {
            providerId: "codex-acp",
            fetchedAt: Date.now(),
            models: [
              { id: "task-model", name: "Task model", providerId: "codex-acp" },
            ],
          },
        ],
      ]),
    });
    useChatSessionStore.setState((state) => ({
      sessions: [...state.sessions, { ...state.sessions[0], id: "s2" }],
    }));
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      text: "old session accepted task",
      persona: { kind: "none" },
      sendOptions: {
        initialExecutorIntent: {
          options: [{ target }],
          priorIds: [],
          roleId: null,
          rolePrompt: "",
          workClassId: "general",
        },
      },
    });
    const selecting = deferred<void>();
    vi.mocked(executorSelection.select).mockImplementation(async (request) => {
      await selecting.promise;
      return initialDecision(request);
    });
    const oldSend = vi.fn().mockResolvedValue(true);
    const newSend = vi.fn().mockResolvedValue(true);
    const view = renderHook(
      ({ sessionId }) =>
        useMessageQueue(
          sessionId,
          "idle",
          sessionId === "s1" ? oldSend : newSend,
        ),
      { initialProps: { sessionId: "s1" } },
    );
    await waitFor(() =>
      expect(executorSelection.select).toHaveBeenCalledTimes(1),
    );
    view.rerender({ sessionId: "s2" });
    await act(async () => selecting.resolve());
    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1[0].payload.text,
    ).toBe("old session accepted task");
    view.rerender({ sessionId: "s1" });
    await waitFor(() => expect(oldSend).toHaveBeenCalledTimes(1));
    expect(newSend).not.toHaveBeenCalled();
    expect(executorSelection.select).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("retains a proven rejected head when account switching clears the wait before dispatch acknowledgment", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    sendMessage.mockImplementationOnce(
      (
        _text: string,
        _persona: unknown,
        _attachments: unknown,
        options: ChatSendOptions,
      ) => {
        options.onUserMessageCommitted?.();
        deferForAccountQuota("s1", {
          data: { kind: "account_quota_wait", promptNotAccepted: true },
        });
        options.onPromptNotAccepted?.();
        useChatStore.getState().setChatState("s1", "thinking");
        clearAccountQuotaWait("s1");
        return Promise.resolve(true);
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "none" },
      text: "retain before acknowledgment",
    });
    const original = useChatStore.getState().queuedMessageBySession.s1[0];
    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());
    expect(useChatStore.getState().queuedMessageBySession.s1[0]).toBe(original);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    act(() => useChatStore.getState().setChatState("s1", "idle"));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("admits under a pending draft id, then dispatches once after promotion", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          clientSessionId: "draft-session",
          title: "Chat",
          executionTarget: { harnessId: "goose" },
          creationState: "pending",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    const dispatch = vi.fn().mockReturnValue(true);
    const { result, rerender } = renderHook(
      ({ sessionId, ready }: { sessionId: string; ready: boolean }) =>
        useMessageQueue(
          sessionId,
          ready ? "idle" : "thinking",
          (text, persona, attachments, options) =>
            dispatch(sessionId, text, persona, attachments, options),
          false,
          false,
          ready,
        ),
      {
        initialProps: { sessionId: "draft-session", ready: false },
      },
    );

    act(() => {
      expect(result.current.enqueue("send when ready")).toBe(true);
    });

    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      payload: { text: "send when ready" },
    });
    expect(dispatch).not.toHaveBeenCalled();

    act(() => {
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["backend-session"]?.[0],
    ).toMatchObject({ payload: { text: "send when ready" } });

    rerender({ sessionId: "backend-session", ready: true });

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.slice(0, 2)).toEqual([
      "backend-session",
      "send when ready",
    ]);
    expect(
      useChatStore.getState().queuedMessageBySession["backend-session"],
    ).toBeUndefined();
  });

  it("drains exactly once when a direct Distillctl lease releases without another state change", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const distillctlLease = acquireSessionDispatchTarget("s1");
    expect(distillctlLease).not.toBeNull();
    expect(acquireSessionDispatchTarget("s1")).toMatchObject({
      status: "contended",
    });

    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "dispatch after Distillctl settles",
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    expect(result.current.queuedMessage?.text).toBe(
      "dispatch after Distillctl settles",
    );
    expect(sendMessage).not.toHaveBeenCalled();

    act(() => distillctlLease.release?.());

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith(
      "dispatch after Distillctl settles",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("holds the dispatch target through queued compaction and send settlement", async () => {
    const initialTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    };
    const updatedTarget = {
      harnessId: "goose" as const,
      modelProviderId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    };
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s1", initialTarget);
    const compaction = deferred<void>();
    const observedTargets: unknown[] = [];
    const sendMessage = vi.fn(
      async (
        _text: string,
        _persona: unknown,
        _attachments: unknown,
        options?: ChatSendOptions,
      ) => {
        observedTargets.push(options?.sessionSelection);
        await compaction.promise;
        observedTargets.push(options?.sessionSelection);
        options?.beforeUserMessageCommitted?.();
        options?.onUserMessageCommitted?.();
        return true;
      },
    );
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    act(() => expect(result.current.enqueue("compact then send")).toBe(true));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const requestId = "selection-during-compaction";
    beginModelSelectionIntent("s1", {
      requestId,
      target: updatedTarget,
      previousTarget: initialTarget,
    });
    const applySelection = transitionSessionTarget({
      sessionId: "s1",
      target: updatedTarget,
      workingDir: "/tmp/project",
      requestId,
    });
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(initialTarget);

    await act(async () => {
      compaction.resolve();
      await compaction.promise;
    });
    await applySelection;
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(updatedTarget);
    expect(observedTargets).toEqual([initialTarget, initialTarget]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("pauses an edited head across an idle transition, then sends the update", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().setChatState("s1", "streaming");
    const { result, rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );

    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "stale",
      });
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";
    act(() => expect(result.current.beginEditing(recordId)).toBe(true));

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    rerender({ chatState: "idle" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({ recordId, editing: true });

    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "updated",
        }),
      ).toBe(true),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      "updated",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("rejects commit after the in-flight queued payload is edited", async () => {
    let commitQueuedMessage!: () => void;
    let resolveSend!: (accepted: boolean) => void;
    const sendMessage = vi.fn(
      (
        _text: string,
        _persona: unknown,
        _attachments: unknown,
        options?: { beforeUserMessageCommitted?: () => void },
      ) => {
        commitQueuedMessage = options?.beforeUserMessageCommitted ?? (() => {});
        return new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        });
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "original",
    });
    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const recordId =
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.recordId ?? "";

    act(() => expect(result.current.beginEditing(recordId)).toBe(true));
    act(() =>
      expect(
        result.current.update(recordId, {
          persona: { kind: "inherit" },
          text: "replacement",
        }),
      ).toBe(true),
    );

    expect(commitQueuedMessage).toThrowError(
      new QueuedMessageOwnershipLostError(),
    );
    act(() => resolveSend(false));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(
      "replacement",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload.text,
    ).toBe("replacement");
  });

  it("drains multiple queued messages in FIFO order as each send settles", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.getState().setChatState("s1", "streaming");
    const { rerender } = renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "streaming" as ChatState } },
    );

    act(() => {
      const store = useChatStore.getState();
      store.enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "first",
      });
      store.enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "second",
      });
      store.enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "third",
      });
    });

    act(() => useChatStore.getState().setChatState("s1", "idle"));
    rerender({ chatState: "idle" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    expect(sendMessage.mock.calls.map(([text]) => text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("waits for restored queue replay readiness before draining", async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useChatStore.setState({
      queuedMessageBySession: {
        s1: [
          {
            kind: "transport-ready",
            recordId: "restored-record",
            payload: {
              persona: { kind: "inherit" },
              text: "restored",
            },
            restored: true,
          },
        ],
      },
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    expect(sendMessage).not.toHaveBeenCalled();

    act(() => useChatStore.getState().markQueuedMessagesReady("s1"));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      "restored",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
  });

  it("does not drain a newly enqueued transport-ready message from the store subscription while rendered readiness is blocked", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    renderHook(() => useMessageQueue("s1", "thinking", sendMessage));

    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("s1", {
        persona: { kind: "inherit" },
        text: "not ready yet",
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({
      text: "not ready yet",
    });
  });

  it("queued messages are scoped to session", () => {
    const sendMessage = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s2", {
      persona: { kind: "inherit" },
      text: "other session",
    });

    const { result } = renderHook(() =>
      useMessageQueue("s1", "idle", sendMessage),
    );

    expect(result.current.queuedMessage).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves tagged agents, skills, and attachments when auto-sending", () => {
    const sendMessage = vi.fn();
    const attachments = [
      {
        id: "file-1",
        kind: "file" as const,
        name: "notes.txt",
        path: "/tmp/notes.txt",
      },
    ];
    const sendOptions = {
      assistantPrompt: "Use these skills for this request: code-review.",
      displayText: "@Reviewer check this diff",
      chips: [
        {
          id: "reviewer",
          label: "Reviewer",
          agentRole: "active" as const,
          type: "agent" as const,
        },
        { label: "code-review", type: "skill" as const },
      ],
    };
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "persona", id: "reviewer" },
      text: "@Reviewer check this diff",
      attachments,
      sendOptions,
    });

    renderHook(
      ({ chatState }: { chatState: ChatState }) =>
        useMessageQueue("s1", chatState, sendMessage),
      { initialProps: { chatState: "idle" as ChatState } },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "@Reviewer check this diff",
      { id: "reviewer" },
      attachments,
      expect.objectContaining({
        ...sendOptions,
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("retains the exact queued head after a pre-commit rejection", async () => {
    let rejectBeforeCommit!: (accepted: boolean) => void;
    const sendMessage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          rejectBeforeCommit = resolve;
        }),
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
      sendOptions: { executionSystemPrompt: "captured prompt" },
    });
    const queuedHead = useChatStore.getState().queuedMessageBySession.s1?.[0];

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    act(() => rejectBeforeCommit(false));
    await waitFor(() =>
      expect(useChatStore.getState().queuedMessageBySession.s1?.[0]).toBe(
        queuedHead,
      ),
    );
  });

  it("does not retry after the queued user turn commits", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(
      (
        _text: string,
        _persona?: { id: string | null; name?: string },
        _attachments?: ChatAttachmentDraft[],
        options?: ChatSendOptions,
      ) => {
        options?.beforeUserMessageCommitted?.();
        options?.onUserMessageCommitted?.();
        return Promise.reject(new Error("transport failed after commit"));
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("stops automatic retries for a persistently rejected payload despite readiness churn", async () => {
    // A failed auto-compaction returns false, appends an error notification,
    // and sets the session back to idle. That idle edge re-triggers the drain,
    // so without a ceiling the send loops as fast as compaction can fail and
    // grows the transcript every pass.
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(false);
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "queued",
    });

    renderHook(() => useMessageQueue("s1", "idle", sendMessage));
    await act(async () => Promise.resolve());

    for (let pass = 0; pass < 12; pass += 1) {
      await act(async () => {
        useChatStore.getState().setChatState("s1", "compacting");
        useChatStore.getState().setChatState("s1", "idle");
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }

    expect(sendMessage).toHaveBeenCalledTimes(5);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toMatchObject({ text: "queued" });
    vi.useRealTimers();
  });

  it("reads live blocked state before draining via store subscription", () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
    chatStore.setChatState("s1", "streaming");
    chatStore.setActiveRunId("s1", "run-1");

    // Mount while the render-derived prop is blocked. In a backgrounded webview,
    // this prop may not update before the store transitions back to idle.
    renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage, false, true),
    );

    expect(sendMessage).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setActiveRunId("s1", null);
      useChatStore.getState().setChatState("s1", "idle");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "background msg",
      undefined,
      undefined,
      expect.objectContaining({
        beforeUserMessageCommitted: expect.any(Function),
      }),
    );
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("keeps a hung attempt fenced across owner remounts", () => {
    const sendMessage = vi.fn(() => new Promise<boolean>(() => {}));
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "background msg",
    });
    chatStore.setChatState("s1", "streaming");

    const firstOwner = renderHook(() =>
      useMessageQueue("s1", "streaming", sendMessage),
    );
    act(() => chatStore.setChatState("s1", "idle"));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    firstOwner.unmount();
    renderHook(() => useMessageQueue("s1", "idle", sendMessage));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
