import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

const mockLoadSession = vi.fn();
const mockNewSession = vi.fn();
const mockSetProvider = vi.fn();
const mockSetModel = vi.fn();
const mockPrompt = vi.fn();
const mockSteerSession = vi.fn();
const mockAppendSessionSystemPrompt = vi.fn();
const mockForkSession = vi.fn();
const mockRenameSession = vi.fn();
const mockArchiveSession = vi.fn();

async function setRuntimeConfig(config: RuntimeConfig) {
  const { useRuntimeConfigStore } = await import(
    "@/shared/runtime-config/runtimeConfigStore"
  );
  useRuntimeConfigStore.setState({
    loaded: true,
    result: { status: "ready", source: "appDefault", config },
    config,
  });
}

const reasoningEffortSnapshot = {
  configId: "reasoning_effort",
  currentValue: "high",
  options: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock("../acpApi", () => ({
  listProviders: vi.fn(),
  prompt: (...args: unknown[]) => {
    const result = mockPrompt(...args);
    const callbacks = args[3] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    callbacks?.onPromptDispatching?.();
    callbacks?.onPromptDispatched?.();
    return result;
  },
  appendSessionSystemPrompt: (...args: unknown[]) =>
    mockAppendSessionSystemPrompt(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  steerSession: (...args: unknown[]) => mockSteerSession(...args),
  listSessions: vi.fn(),
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  newSession: (...args: unknown[]) => mockNewSession(...args),
  exportSession: vi.fn(),
  importSession: vi.fn(),
  forkSession: (...args: unknown[]) => mockForkSession(...args),
  renameSession: (...args: unknown[]) => mockRenameSession(...args),
  archiveSession: (...args: unknown[]) => mockArchiveSession(...args),
  cancelSession: vi.fn(),
}));

const mockGetDistillctlPreamble = vi.fn<
  () => string | null | Promise<string | null>
>(() => null);

vi.mock("@/features/distillctl/appPreamble", () => ({
  getDistillctlPreamble: () => mockGetDistillctlPreamble(),
}));

vi.mock("../acpActiveMessageTracking", () => ({
  setActiveMessageId: vi.fn(),
  clearActiveMessageId: vi.fn(),
}));

vi.mock("../sessionSearch", () => ({
  searchSessionsViaTranscripts: vi.fn(),
}));

describe("acpSteerMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("blocks transport when the prepared session has no acknowledged model", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSteerMessage } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "acp-session-steer-missing-model",
      "goose",
      "/tmp/project",
    );

    await expect(
      acpSteerMessage("acp-session-steer-missing-model", "run-1", "more"),
    ).rejects.toThrow("configured provider and model");

    expect(mockSteerSession).not.toHaveBeenCalled();
  });
});

describe("acpSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // clearAllMocks clears call history but not return values; reset the
    // preamble to unavailable so tests opt in explicitly.
    mockGetDistillctlPreamble.mockReturnValue(null);
  });

  it("blocks transport when the prepared session has no acknowledged model", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "acp-session-missing-model",
      "goose",
      "/tmp/project",
    );

    await expect(
      acpSendMessage("acp-session-missing-model", "hello"),
    ).rejects.toThrow("configured provider and model");

    expect(mockAppendSessionSystemPrompt).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("reports dispatch only after ACP setup reaches the transport boundary", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const onPromptDispatched = vi.fn();
    sessionRegistry.registerPreparedSession(
      "acp-session-dispatch-boundary",
      "goose",
      "/tmp/project",
      "test-model",
    );
    mockGetDistillctlPreamble.mockRejectedValueOnce(
      new Error("ACP setup failed"),
    );

    await expect(
      acpSendMessage("acp-session-dispatch-boundary", "hello", {
        onPromptDispatched,
      }),
    ).rejects.toThrow("ACP setup failed");

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(onPromptDispatched).not.toHaveBeenCalled();
  });

  it("does not consume an external persona handoff when ownership fails", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();
    sessionRegistry.registerPreparedSession(
      "acp-session-canceled-handoff",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );
    mockPrompt.mockImplementationOnce(
      (
        _sessionId: string,
        _content: unknown,
        _meta: unknown,
        callbacks?: { onPromptDispatching?: () => void },
      ) => {
        callbacks?.onPromptDispatching?.();
        return Promise.resolve();
      },
    );

    await expect(
      acpSendMessage("acp-session-canceled-handoff", "canceled", {
        systemPrompt: "You are Starfriend.",
        onPromptDispatching: () => {
          throw new DOMException("canceled", "AbortError");
        },
      }),
    ).rejects.toThrow("canceled");
    await acpSendMessage("acp-session-canceled-handoff", "retry", {
      systemPrompt: "You are Starfriend.",
    });

    const [, retryBlocks] = mockPrompt.mock.calls[1];
    expect(retryBlocks[0].text).toContain("You are Starfriend.");
  });

  it("only hands the persona off once per agent, but re-injects after an agent switch", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-switch",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-switch", "first", {
      systemPrompt: "You are Starfriend.",
    });
    await acpSendMessage("acp-session-switch", "second", {
      systemPrompt: "You are Starfriend.",
    });

    // First send injects the handoff, second does not.
    expect(mockPrompt.mock.calls[0][1][0].text).toContain(
      "You are Starfriend.",
    );
    expect(mockPrompt.mock.calls[1][1][0]).toEqual({
      type: "text",
      text: "second",
    });

    // Switching the session to a different agent re-triggers the handoff.
    sessionRegistry.registerPreparedSession(
      "acp-session-switch",
      "codex-acp",
      "/tmp/project",
      "test-model",
    );
    await acpSendMessage("acp-session-switch", "third", {
      systemPrompt: "You are Starfriend.",
    });
    expect(mockPrompt.mock.calls[2][1][0].text).toContain(
      "You are Starfriend.",
    );
  });

  it("does not apply model config after prompt admission until the prompt finishes", async () => {
    const promptSetup = deferred<string | null>();
    const promptResponse = deferred<void>();
    mockGetDistillctlPreamble.mockReturnValueOnce(promptSetup.promise);
    mockPrompt.mockReturnValueOnce(promptResponse.promise);
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const sessionId = "acp-session-prompt-config-race";
    sessionRegistry.registerPreparedSession(
      sessionId,
      "codex-acp",
      "/tmp/project",
      "gpt-5.5",
    );

    const send = acpSendMessage(sessionId, "hello");
    await vi.waitFor(() =>
      expect(mockGetDistillctlPreamble).toHaveBeenCalled(),
    );
    const setModel = sessionRegistry.applySessionModel(sessionId, "gpt-5.6");
    await Promise.resolve();

    expect(mockSetModel).not.toHaveBeenCalled();

    promptSetup.resolve(null);
    await vi.waitFor(() => expect(mockPrompt).toHaveBeenCalled());
    expect(mockSetModel).not.toHaveBeenCalled();

    promptResponse.resolve(undefined);
    await send;
    await setModel;

    expect(mockPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetModel.mock.invocationCallOrder[0],
    );
  });
});

describe("acpLoadSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("restores the prior prepared session registration when replay loading fails", async () => {
    mockLoadSession.mockRejectedValueOnce(new Error("load failed"));

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-1",
      "goose",
      "/tmp/original",
      "gpt-5.6",
    );

    await expect(
      acpLoadSession("acp-session-1", "/tmp/replay"),
    ).rejects.toThrow("load failed");

    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
    await sessionRegistry.applySessionModel("acp-session-1", "gpt-5.6");
    expect(mockSetModel).not.toHaveBeenCalled();
  });
});

describe("acpCreateSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSetProvider.mockReset();
    mockSetProvider.mockResolvedValue({ model: null, reasoningEffort: null });
    mockSetModel.mockReset();
    mockSetModel.mockResolvedValue({ model: null, reasoningEffort: null });
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("opens the session on the chosen model, effort and fast mode in session/new itself", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const { acpCreateSession } = await import("../acp");

    await acpCreateSession("claude-acp", "/tmp/project", {
      modelId: "claude-opus-4-6",
      reasoningEffort: "max",
      fastMode: false,
    });

    expect(mockNewSession).toHaveBeenCalledWith("/tmp/project", {
      providerId: "claude-acp",
      projectId: undefined,
      personaId: undefined,
      modelId: "claude-opus-4-6",
      reasoningEffort: "max",
      fastMode: false,
    });
  });

  it("does not resurrect provider defaults absent from the final model snapshot", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });
    mockSetProvider.mockResolvedValueOnce({
      model: { modelId: "gpt-5.5", modelName: "GPT-5.5" },
      reasoningEffort: reasoningEffortSnapshot,
    });
    mockSetModel.mockResolvedValueOnce({
      model: { modelId: "claude-fable", modelName: "Claude Fable" },
      reasoningEffort: null,
    });

    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("anthropic", "/tmp/project", {
        modelId: "claude-fable",
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: { modelId: "claude-fable", modelName: "Claude Fable" },
        reasoningEffort: null,
      },
    });
  });
});

describe("acpPrepareSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("surfaces load failures instead of creating a new ACP session", async () => {
    mockLoadSession.mockRejectedValueOnce(new Error("missing session"));

    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("acp-session-1", "openai", "/tmp/project"),
    ).rejects.toThrow("missing session");

    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSetProvider).not.toHaveBeenCalled();
  });
});
