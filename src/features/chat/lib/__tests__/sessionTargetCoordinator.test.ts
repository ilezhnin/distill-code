import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionConfigSnapshots } from "@/shared/api/acpSessionConfigSnapshots";
import {
  type ChatSession,
  type ChatSessionReasoningEffortConfig,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { reconcileSessionRunSettings } from "../runSettingsReconciler";
import {
  observeSessionTargetConfigSnapshots,
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "../sessionTargetCoordinator";

const mocks = vi.hoisted(() => ({
  acpPrepareSession: vi.fn(),
  acpApplySessionRunSettings: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpApplySessionRunSettings: (...args: unknown[]) =>
    mocks.acpApplySessionRunSettings(...args),
}));

function seedSession(
  modelId: string,
  harnessId = "codex-acp",
  overrides: Partial<ChatSession> = {},
): ChatSession {
  const session: ChatSession = {
    id: "session-1",
    title: "Chat",
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z",
    messageCount: 0,
    executionTarget: {
      harnessId,
      modelProviderId: harnessId,
      modelId,
      modelName: modelId,
    },
    executionTargetSource: "ui",
    ...overrides,
  };
  useChatSessionStore.setState({ sessions: [session] });
  return session;
}

function effortMenu(currentValue: string): ChatSessionReasoningEffortConfig {
  return {
    configId: "reasoning_effort",
    currentValue,
    options: ["low", "medium", "high"].map((id) => ({ id, name: id })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function liveSession(): ChatSession | undefined {
  return useChatSessionStore.getState().getSession("session-1");
}

describe("run settings in a target transition", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [] });
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.acpApplySessionRunSettings.mockResolvedValue(undefined);
  });

  it("changes the effort without moving the execution target or superseding a send waiting on the session", async () => {
    const seeded = seedSession("gpt-5.5", "codex-acp", {
      reasoningEffort: effortMenu("medium"),
    });
    const prepared = deferred<AcpSessionConfigSnapshots | undefined>();
    mocks.acpPrepareSession.mockReturnValueOnce(prepared.promise);
    const effortAnswer: AcpSessionConfigSnapshots = {
      model: { modelId: "gpt-5.5", modelName: "gpt-5.5" },
      reasoningEffort: effortMenu("high"),
      fastMode: null,
    };
    mocks.acpApplySessionRunSettings.mockImplementation(
      async (sessionId, _write, context) => {
        // The answer fans out through the snapshot handlers the way acpApi
        // dispatches a real response.
        observeSessionTargetConfigSnapshots({
          sessionId,
          snapshots: effortAnswer,
          context: { origin: "response", ...context },
        });
        return effortAnswer;
      },
    );

    const send = transitionSessionTarget({
      sessionId: "session-1",
      target: seeded.executionTarget as NonNullable<
        ChatSession["executionTarget"]
      >,
      workingDir: "/project",
      origin: "queued-send",
      requestId: "send-1",
    });
    await vi.waitFor(() =>
      expect(mocks.acpPrepareSession).toHaveBeenCalledTimes(1),
    );

    // What the effort pill does: record the intent, paint the value, apply.
    useChatSessionStore.getState().patchSession("session-1", {
      desiredRunSettings: { effort: "high" },
      reasoningEffort: effortMenu("high"),
    });
    await reconcileSessionRunSettings({
      sessionId: "session-1",
      desired: { effort: "high" },
      menus: { reasoningEffort: effortMenu("medium") },
    });

    prepared.resolve(effortAnswer);
    const outcome = await send;

    expect(outcome.status).toBe("committed");
    expect(mocks.acpPrepareSession).toHaveBeenCalledTimes(1);
    expect(mocks.acpApplySessionRunSettings).toHaveBeenCalledTimes(1);
    expect(mocks.acpApplySessionRunSettings).toHaveBeenCalledWith(
      "session-1",
      { effort: { configId: "reasoning_effort", value: "high" } },
      expect.objectContaining({ modelId: "gpt-5.5" }),
    );
    expect(liveSession()?.executionTarget).toEqual(seeded.executionTarget);
    expect(liveSession()?.reasoningEffort?.currentValue).toBe("high");
  });
});

describe("session store subscription", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [] });
  });

  it("publishes replayed model and effort snapshots only when their values change", () => {
    seedSession("example-model", "example-provider", {
      executionTargetSource: "acp",
      reasoningEffort: effortMenu("high"),
    });
    const initial = useChatSessionStore.getState();
    const listener = vi.fn();
    const unsubscribe = useChatSessionStore.subscribe(listener);
    const observe = (currentValue: string) =>
      observeSessionTargetConfigSnapshots({
        sessionId: "session-1",
        snapshots: {
          model: { modelId: "example-model", modelName: "example-model" },
          reasoningEffort: effortMenu(currentValue),
        },
        context: { origin: "notification" },
      });
    try {
      // Loading a session replays independently parsed copies of its config
      // notifications. They must not repeatedly invalidate the Home draft.
      for (let i = 0; i < 100; i++) observe("high");
      expect(useChatSessionStore.getState()).toBe(initial);
      expect(listener).not.toHaveBeenCalled();

      observe("low");
      expect(liveSession()?.reasoningEffort?.currentValue).toBe("low");
      expect(listener).toHaveBeenCalledTimes(1);
      observe("low");
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("still publishes a changed effort menu for the same model", () => {
    seedSession("example-model", "example-provider", {
      executionTargetSource: "acp",
      reasoningEffort: effortMenu("high"),
    });
    observeSessionTargetConfigSnapshots({
      sessionId: "session-1",
      snapshots: {
        model: { modelId: "example-model", modelName: "example-model" },
        reasoningEffort: {
          ...effortMenu("high"),
          options: [{ id: "high", name: "High effort" }],
        },
      },
      context: { origin: "notification" },
    });
    expect(liveSession()?.reasoningEffort?.options).toEqual([
      { id: "high", name: "High effort" },
    ]);
  });

  it("leaves the session list alone on writes that do not replace it", () => {
    seedSession("gpt-5.5");
    const sessions = useChatSessionStore.getState().sessions;
    const readSessions = vi.spyOn(sessions, "map");

    useChatSessionStore.setState({ isLoading: true });
    useChatSessionStore.setState({ isRightRailOpen: true });

    expect(readSessions).not.toHaveBeenCalled();
  });

  it("still settles a pending transition when its session leaves the list", async () => {
    seedSession("gpt-5.5");
    const prepared = deferred<AcpSessionConfigSnapshots>();
    mocks.acpPrepareSession.mockReturnValue(prepared.promise);
    const transition = transitionSessionTarget({
      sessionId: "session-1",
      target: {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "gpt-5.6",
        modelName: "gpt-5.6",
      },
      workingDir: "/project",
    });
    await vi.waitFor(() =>
      expect(mocks.acpPrepareSession).toHaveBeenCalledTimes(1),
    );

    useChatSessionStore.setState({ sessions: [] });
    prepared.resolve({} as AcpSessionConfigSnapshots);

    await expect(transition).resolves.toMatchObject({
      status: "session-missing",
    });
  });
});
