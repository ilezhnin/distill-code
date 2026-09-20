import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

import { INTERACTION_NORMS_PREAMBLE } from "@/shared/api/interactionNorms";

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
const noRequestProviderContext = { requestId: undefined };
const noRequestModelContext = (providerId: string) => ({
  providerId,
  requestId: undefined,
});

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

const EXTERNAL_AGENT_PROVIDER_IDS = ["claude-acp", "codex-acp"] as const;
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

function executionConfigResponse(providerId: string, modelId: string) {
  return {
    configOptions: [
      {
        id: "provider",
        kind: { type: "select", currentValue: providerId, options: [] },
      },
      {
        id: "model",
        category: "model",
        kind: { type: "select", currentValue: modelId, options: [] },
      },
    ],
  };
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

  it("reports dispatch immediately after invoking the external prompt", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const onPromptDispatched = vi.fn();
    let resolvePrompt!: () => void;
    mockPrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      }),
    );
    sessionRegistry.registerPreparedSession(
      "acp-session-dispatched",
      "goose",
      "/tmp/project",
      "test-model",
    );

    const send = acpSendMessage("acp-session-dispatched", "hello", {
      onPromptDispatched,
    });
    await vi.waitFor(() => expect(onPromptDispatched).toHaveBeenCalledOnce());
    expect(mockPrompt).toHaveBeenCalledOnce();

    resolvePrompt();
    await send;
  });

  it("hands the interaction norms off in-band for external agents, before the persona", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-norms-ext",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-norms-ext", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain(INTERACTION_NORMS_PREAMBLE);
    expect(blocks[0].text.indexOf(INTERACTION_NORMS_PREAMBLE)).toBeLessThan(
      blocks[0].text.indexOf("You are Starfriend."),
    );
  });

  it("hands the distillctl preamble off in-band for external agents, before the persona", async () => {
    mockGetDistillctlPreamble.mockReturnValue(
      "[Distill]\ndistillctl is on your PATH.",
    );

    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-preamble-ext",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-preamble-ext", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("distillctl is on your PATH.");
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[0].text.indexOf("distillctl is on your PATH.")).toBeLessThan(
      blocks[0].text.indexOf("You are Starfriend."),
    );
  });

  it("hands the distillctl preamble off for external agents even without a persona", async () => {
    mockGetDistillctlPreamble.mockReturnValue(
      "[Distill]\ndistillctl is on your PATH.",
    );

    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-preamble-only",
      "codex-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-preamble-only", "hello", {});

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("distillctl is on your PATH.");
  });

  it.each(
    EXTERNAL_AGENT_PROVIDER_IDS,
  )("hands the persona off in-band on the first prompt for %s", async (providerId) => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      `acp-session-${providerId}`,
      providerId,
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage(`acp-session-${providerId}`, "hello", {
      systemPrompt: "You are Starfriend.",
    });

    // External agents ignore the goose system-prompt ext method, so we must
    // not call it for them.
    expect(mockAppendSessionSystemPrompt).not.toHaveBeenCalled();

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[blocks.length - 1]).toEqual({
      type: "text",
      text: "hello",
    });
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

  it("merges the persona handoff with a skill assistant prompt, persona first", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-codex",
      "codex-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-codex", "hello", {
      systemPrompt: "You are Starfriend.",
      assistantPrompt: "Use these skills for this request: goose-help.",
    });

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[0].text).toContain(
      "Use these skills for this request: goose-help.",
    );
    expect(blocks[0].text.indexOf("You are Starfriend.")).toBeLessThan(
      blocks[0].text.indexOf("Use these skills"),
    );
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

  it("registers the provider and model acknowledged by session load", async () => {
    mockLoadSession.mockResolvedValueOnce(
      executionConfigResponse("databricks_v2", "goose-gpt-5-6-sol"),
    );
    const { acpLoadSession, acpPrepareSession } = await import("../acp");

    await acpLoadSession("acp-session-1", "/tmp/replay");
    await acpPrepareSession("acp-session-1", "databricks_v2", "/tmp/replay", {
      modelId: "goose-gpt-5-6-sol",
    });

    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).not.toHaveBeenCalled();
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("does not replay a loaded session when its execution selection is unknown", async () => {
    mockLoadSession.mockResolvedValueOnce({ configOptions: [] });
    const { acpLoadSession, acpPrepareSession } = await import("../acp");

    await acpLoadSession("acp-session-1", "/tmp/replay");
    await acpPrepareSession("acp-session-1", "openai", "/tmp/replay", {
      modelId: "gpt-5.6",
    });

    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).toHaveBeenCalledWith(
      "acp-session-1",
      "openai",
      noRequestProviderContext,
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });

  it("hydrates reasoning effort from the load response config options", async () => {
    mockLoadSession.mockResolvedValueOnce({
      configOptions: [
        {
          id: "reasoning_effort",
          category: "thought_level",
          kind: {
            type: "select",
            currentValue: "medium",
            options: {
              type: "ungrouped",
              values: [
                { value: "off", name: "off" },
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          },
        },
      ],
    });
    const applyReasoningEffortConfigSnapshot = vi.fn();

    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    setSessionConfigSnapshotHandlers({
      applyReasoningEffortConfigSnapshot,
    });
    const { acpLoadSession } = await import("../acp");

    await acpLoadSession("acp-session-1", "/tmp/replay");

    expect(applyReasoningEffortConfigSnapshot).toHaveBeenCalledWith(
      "acp-session-1",
      {
        configId: "reasoning_effort",
        currentValue: "medium",
        options: [
          { id: "off", name: "off" },
          { id: "low", name: "low" },
          { id: "medium", name: "medium" },
          { id: "high", name: "high" },
        ],
      },
      { origin: "response" },
    );
  });

  it("does not dispatch a load snapshot superseded by a UI configuration", async () => {
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);
    mockSetProvider.mockResolvedValueOnce(undefined);
    const applyModelConfigSnapshot = vi.fn();
    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    setSessionConfigSnapshotHandlers({ applyModelConfigSnapshot });
    const sessionRegistry = await import("../acpSessionRegistry");
    sessionRegistry.registerPreparedSession(
      "acp-session-race",
      "openai",
      "/tmp/replay",
      "gpt-5.6",
    );
    const { acpLoadSession, acpPrepareSession } = await import("../acp");

    const load = acpLoadSession("acp-session-race", "/tmp/replay");
    const configure = acpPrepareSession(
      "acp-session-race",
      "openai",
      "/tmp/replay",
      { modelId: "gpt-5.6" },
    );
    loadResponse.resolve(executionConfigResponse("openai", "gpt-5.5"));

    await load;
    await configure;

    expect(applyModelConfigSnapshot).not.toHaveBeenCalled();
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-race",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
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

  it("uses the ACP session id as the UI session id", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("openai", "/tmp/project", {
        projectId: "project-1",
        personaId: "persona-1",
        modelId: "gpt-4.1",
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: null,
        reasoningEffort: null,
      },
    });

    expect(mockNewSession).toHaveBeenCalledWith("/tmp/project", {
      providerId: "openai",
      projectId: "project-1",
      personaId: "persona-1",
      modelId: "gpt-4.1",
    });
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "gpt-4.1",
      noRequestModelContext("openai"),
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
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

  it("archives and unregisters a newly created session when eager model setup fails", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "orphaned-session" });
    mockSetModel.mockRejectedValueOnce(new Error("model setup failed"));

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("openai", "/tmp/project", { modelId: "gpt-4.1" }),
    ).rejects.toThrow("model setup failed");
    expect(mockArchiveSession).toHaveBeenCalledWith("orphaned-session");
    expect(sessionRegistry.isSessionPrepared("orphaned-session")).toBe(false);
  });

  it("returns the latest config snapshot from session creation setup", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });
    mockSetProvider.mockResolvedValueOnce({
      model: null,
      reasoningEffort: null,
    });
    mockSetModel.mockResolvedValueOnce({
      model: {
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
      },
      reasoningEffort: reasoningEffortSnapshot,
    });

    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("openai", "/tmp/project", {
        modelId: "gpt-4.1",
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: {
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        reasoningEffort: reasoningEffortSnapshot,
      },
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

describe("acpDuplicateSession", () => {
  const forkedSession = {
    sessionId: "session-2",
    title: "Fork",
    userSetName: false,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("delegates the session id and working dir to direct ACP", async () => {
    mockForkSession.mockResolvedValueOnce(forkedSession);

    const { acpDuplicateSession } = await import("../acp");

    await expect(
      acpDuplicateSession("session-1", "/tmp/project"),
    ).resolves.toEqual(forkedSession);
    expect(mockForkSession).toHaveBeenCalledWith(
      "session-1",
      "/tmp/project",
      undefined,
    );
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it("delegates fork options to direct ACP", async () => {
    mockForkSession.mockResolvedValueOnce(forkedSession);

    const { acpDuplicateSession } = await import("../acp");

    await acpDuplicateSession("session-1", "/tmp/project", undefined, {
      conversationBefore: 1_700_000_123,
    });

    expect(mockForkSession).toHaveBeenCalledWith("session-1", "/tmp/project", {
      conversationBefore: 1_700_000_123,
    });
  });

  it("renames duplicated sessions when a duplicate title is provided", async () => {
    mockForkSession.mockResolvedValueOnce(forkedSession);

    const { acpDuplicateSession } = await import("../acp");

    await expect(
      acpDuplicateSession("session-1", "/tmp/project", "Copy of Chat One"),
    ).resolves.toEqual({ ...forkedSession, title: "Copy of Chat One" });
    expect(mockForkSession).toHaveBeenCalledWith(
      "session-1",
      "/tmp/project",
      undefined,
    );
    expect(mockRenameSession).toHaveBeenCalledWith(
      "session-2",
      "Copy of Chat One",
    );
  });

  it("keeps the duplicated session when the cosmetic rename fails", async () => {
    const error = new Error("rename failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockForkSession.mockResolvedValueOnce(forkedSession);
    mockRenameSession.mockRejectedValueOnce(error);

    const { acpDuplicateSession } = await import("../acp");

    await expect(
      acpDuplicateSession("session-1", "/tmp/project", "Copy of Chat One"),
    ).resolves.toEqual(forkedSession);
    expect(mockRenameSession).toHaveBeenCalledWith(
      "session-2",
      "Copy of Chat One",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to rename duplicated session:",
      error,
    );
    consoleError.mockRestore();
  });
});

describe("acpPrepareSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("loads the existing ACP session instead of creating a replacement", async () => {
    mockLoadSession.mockResolvedValue(undefined);

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("acp-session-1", "openai", "/tmp/project"),
    ).resolves.toBeDefined();

    expect(mockLoadSession).toHaveBeenCalledWith(
      "acp-session-1",
      "/tmp/project",
    );
    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSetProvider).toHaveBeenCalledWith(
      "acp-session-1",
      "openai",
      noRequestProviderContext,
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
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
