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
  observeSessionTargetModelSnapshot,
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

function observe(
  snapshotModelId: string,
  contextModelId: string,
  harnessId = "codex-acp",
): boolean {
  return observeSessionTargetModelSnapshot({
    sessionId: "session-1",
    snapshot: { modelId: snapshotModelId, modelName: snapshotModelId },
    context: {
      origin: "response",
      providerId: harnessId,
      modelId: contextModelId,
    },
  });
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

describe("observeSessionTargetModelSnapshot", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("accepts a snapshot that still folds the effort into the model id", () => {
    seedSession("gpt-5.6-sol");

    expect(observe("gpt-5.6-sol[ultra]", "gpt-5.6-sol[ultra]")).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("accepts a base-id snapshot for a target that still carries the effort", () => {
    seedSession("gpt-5.6-sol[ultra]");

    expect(observe("gpt-5.6-sol", "gpt-5.6-sol")).toBe(true);
  });

  it("drops a snapshot that names a different model", () => {
    seedSession("gpt-5.6-sol");

    expect(observe("gpt-6-astra[ultra]", "gpt-6-astra[ultra]")).toBe(false);
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({ executionTarget: { modelId: "gpt-5.6-sol" } });
  });

  it("drops a snapshot whose context names a model the response does not", () => {
    seedSession("gpt-5.6-sol");

    expect(observe("gpt-5.6-sol[ultra]", "gpt-6-astra[ultra]")).toBe(false);
  });

  it("keeps a context lane apart from the model without it", () => {
    seedSession("opus[1m]", "claude-acp");

    expect(observe("opus", "opus", "claude-acp")).toBe(false);
  });
});

describe("run settings in a target transition", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [] });
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.acpApplySessionRunSettings.mockResolvedValue(undefined);
  });

  it("applies the model, then the effort, then fast, all under the selection's one request id", async () => {
    seedSession("gpt-5.5", "codex-acp", {
      desiredRunSettings: { effort: "high", fast: true },
    });
    const wire: unknown[][] = [];
    mocks.acpPrepareSession.mockImplementation(
      async (_sessionId, _providerId, _workingDir, options) => {
        wire.push(["model", options.modelId, options.requestId]);
        const modelAnswer: AcpSessionConfigSnapshots = {
          model: { modelId: "gpt-6-astra", modelName: "GPT-6-Astra" },
          reasoningEffort: effortMenu("medium"),
          fastMode: { configId: "fast-mode", enabled: false, kind: "select" },
        };
        // Stands in for the registry, which runs the planner inside the same
        // mutation as the model apply.
        const write = options.planRunSettings?.(modelAnswer);
        if (write?.effort) {
          wire.push(["effort", write.effort.value, options.requestId]);
        }
        if (write?.fast) {
          wire.push(["fast", write.fast.value, options.requestId]);
        }
        return {
          ...modelAnswer,
          reasoningEffort: effortMenu("high"),
          fastMode: { configId: "fast-mode", enabled: true, kind: "select" },
        };
      },
    );

    const outcome = await transitionSessionTarget({
      sessionId: "session-1",
      target: {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "gpt-6-astra",
        modelName: "GPT-6-Astra",
      },
      workingDir: "/project",
      origin: "picker",
      operationId: "select-1",
    });

    expect(outcome.status).toBe("committed");
    expect(wire).toEqual([
      ["model", "gpt-6-astra", "select-1"],
      ["effort", "high", "select-1"],
      ["fast", true, "select-1"],
    ]);
    // Everything the intent asked for landed inside the model apply, so the
    // reconcile that follows the commit has nothing left to write.
    expect(mocks.acpApplySessionRunSettings).not.toHaveBeenCalled();
    expect(liveSession()).toMatchObject({
      executionTarget: { modelId: "gpt-6-astra" },
      reasoningEffort: { currentValue: "high" },
      fastMode: { enabled: true },
      desiredRunSettings: { effort: "high", fast: true },
    });
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
