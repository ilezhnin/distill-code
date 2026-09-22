import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpReasoningEffortConfigSnapshot,
  AcpSessionConfigSnapshots,
} from "../acpSessionConfigSnapshots";

const mockSetModel = vi.fn();
const mockSetProvider = vi.fn();
const mockSetSessionConfigOption = vi.fn();
const mockUpdateWorkingDir = vi.fn();
const mockLoadSession = vi.fn();
const mockInvalidateClientConnection = vi.fn();
const noRequestProviderContext = { requestId: undefined };
const noRequestModelContext = (providerId: string) => ({
  providerId,
  requestId: undefined,
});

vi.mock("../acpConnection", () => ({
  invalidateClientConnectionIfUnresponsive: (...args: unknown[]) =>
    mockInvalidateClientConnection(...args),
}));

vi.mock("../acpApi", () => ({
  setModel: (...args: unknown[]) => mockSetModel(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  setSessionConfigOption: (...args: unknown[]) =>
    mockSetSessionConfigOption(...args),
  updateWorkingDir: (...args: unknown[]) => mockUpdateWorkingDir(...args),
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
}));

async function importRegistry() {
  return import("../acpSessionRegistry");
}

async function importPreparedRegistry(
  providerId = "codex-acp",
  modelId: string | undefined = "default-model",
) {
  const registry = await importRegistry();
  registry.registerPreparedSession(
    "session-1",
    providerId,
    "/project",
    modelId,
  );
  return registry;
}

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

function modelConfigResponse(
  modelId: string,
  modelName: string,
  reasoningEffort: AcpReasoningEffortConfigSnapshot | null = null,
): AcpSessionConfigSnapshots {
  return { model: { modelId, modelName }, reasoningEffort };
}

describe("applySessionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSetModel.mockResolvedValue(undefined);
    mockSetProvider.mockResolvedValue(undefined);
    mockSetSessionConfigOption.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockLoadSession.mockResolvedValue(undefined);
    mockInvalidateClientConnection.mockResolvedValue(undefined);
  });

  it("sends setModel over the wire and records it for the session", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "  gpt-5.5  ");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.5",
      noRequestModelContext("codex-acp"),
    );
  });

  it("skips the wire call when the same model is re-applied", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("sends setModel again when the model actually changes", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.4");

    expect(mockSetModel).toHaveBeenCalledTimes(2);
    expect(mockSetModel).toHaveBeenLastCalledWith(
      "session-1",
      "gpt-5.4",
      noRequestModelContext("codex-acp"),
    );
  });

  it("retries over the wire after a failed setModel", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");

    mockSetModel.mockRejectedValueOnce(new Error("backend rejected model"));
    await expect(
      registry.applySessionModel("session-1", "gpt-5.4"),
    ).rejects.toThrow("backend rejected model");

    // The failure cleared the cached model, so re-applying the previously
    // successful model must go back over the wire instead of being skipped.
    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(3);
    expect(mockSetModel).toHaveBeenLastCalledWith(
      "session-1",
      "gpt-5.5",
      noRequestModelContext("codex-acp"),
    );
  });

  it("clears the cached model when the provider changes", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(1);

    // Provider change rebuilds the backend provider with its default model,
    // so the cached model id no longer reflects backend state.
    await registry.prepareSession("session-1", "claude-acp", "/project");
    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "claude-acp",
      noRequestProviderContext,
    );

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached model across a no-op prepareSession reuse", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.prepareSession("session-1", "codex-acp", "/project");
    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).not.toHaveBeenCalled();
  });

  it("rejects model changes when the provider was never prepared", async () => {
    const registry = await importRegistry();

    await expect(
      registry.applySessionModel("session-unprepared", "gpt-5.5"),
    ).rejects.toThrow("Session not prepared");

    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("records the complete provider response selection atomically", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetProvider.mockResolvedValueOnce(
      modelConfigResponse("claude-fable", "Claude Fable"),
    );

    await registry.prepareSession("session-1", "anthropic", "/project");
    await registry.applySessionModel("session-1", "claude-fable");

    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "anthropic",
      noRequestProviderContext,
    );
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("serializes a newer provider selection behind an in-flight load", async () => {
    const registry = await importPreparedRegistry("anthropic", "claude-fable");
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);

    const load = registry.loadSession("session-1", "/project");
    const configure = registry.configureSession(
      "session-1",
      "anthropic",
      "/project",
      "claude-fable",
    );

    await vi.waitFor(() => expect(mockLoadSession).toHaveBeenCalledTimes(1));
    expect(mockSetProvider).not.toHaveBeenCalled();

    loadResponse.resolve(executionConfigResponse("openai", "gpt-4.1"));
    await expect(load).resolves.toMatchObject({ isCurrent: false });
    await configure;

    expect(registry.getPreparedProviderId("session-1")).toBe("anthropic");
    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "anthropic",
      noRequestProviderContext,
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "claude-fable",
      noRequestModelContext("anthropic"),
    );
  });

  it("serializes a model switch behind an in-flight config option", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-5.5");
    const configResponse = deferred<AcpSessionConfigSnapshots>();
    mockSetSessionConfigOption.mockReturnValueOnce(configResponse.promise);

    const reasoning = registry.applySessionConfigOption(
      "session-1",
      "reasoning_effort",
      "high",
      {
        providerId: "openai",
        modelId: "gpt-5.5",
        reasoningEffortValue: "high",
      },
    );
    const model = registry.applySessionModel("session-1", "gpt-5.6");

    await vi.waitFor(() =>
      expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(1),
    );
    expect(mockSetModel).not.toHaveBeenCalled();

    configResponse.resolve(modelConfigResponse("gpt-5.5", "GPT-5.5"));
    await reasoning;
    await model;

    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });

  it("blocks prompting when preparation has no acknowledged model", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");
    const prompt = vi.fn().mockResolvedValue("complete");

    await expect(
      registry.runPreparedSessionPrompt("session-1", prompt),
    ).rejects.toThrow("configured provider and model");

    expect(registry.isSessionPrepared("session-1")).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("admits prompting after provider preparation acknowledges a model", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "openai", "/project");
    mockSetProvider.mockResolvedValueOnce(
      modelConfigResponse("gpt-5.5", "GPT-5.5"),
    );
    const prompt = vi.fn().mockResolvedValue("complete");

    await registry.prepareSession("session-1", "anthropic", "/project");

    await expect(
      registry.runPreparedSessionPrompt("session-1", prompt),
    ).resolves.toBe("complete");
    expect(registry.isSessionPrepared("session-1")).toBe(true);
    expect(prompt).toHaveBeenCalledWith("anthropic");
  });

  it("does not time out a long-running prompt or admit config work mid-turn", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importPreparedRegistry("openai", "gpt-5.5");
      const promptResponse = deferred<string>();
      let promptSettled = false;

      const prompt = registry
        .runPreparedSessionPrompt("session-1", () => promptResponse.promise)
        .finally(() => {
          promptSettled = true;
        });
      const model = registry.applySessionModel("session-1", "gpt-5.6");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(promptSettled).toBe(false);
      expect(mockInvalidateClientConnection).not.toHaveBeenCalled();
      expect(mockSetModel).not.toHaveBeenCalled();

      promptResponse.resolve("complete");
      await expect(prompt).resolves.toBe("complete");
      await expect(model).resolves.toBeUndefined();
      expect(mockSetModel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // The timeout is per request: the stuck mutation is rejected and its
  // prepared entry dropped, but the socket every other chat shares is only
  // checked for liveness, never closed outright (a timed-out config call in
  // one chat used to fail every other chat's in-flight prompt).
  it("times out a stuck mutation, checks the transport, and admits queued work", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importPreparedRegistry("openai", "gpt-5.5");
      const stuck = deferred<AcpSessionConfigSnapshots>();
      mockSetSessionConfigOption.mockReturnValueOnce(stuck.promise);
      mockLoadSession.mockResolvedValueOnce(
        executionConfigResponse("openai", "gpt-5.5"),
      );
      mockInvalidateClientConnection.mockResolvedValueOnce(false);

      const reasoning = registry.applySessionConfigOption(
        "session-1",
        "reasoning_effort",
        "high",
      );
      const load = registry.loadSession("session-1", "/project");

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(reasoning).rejects.toThrow("ACP operation timed out");
      await expect(load).resolves.toMatchObject({ isCurrent: true });
      expect(mockInvalidateClientConnection).toHaveBeenCalledOnce();
      expect(mockLoadSession).toHaveBeenCalledOnce();
      expect(registry.getPreparedProviderId("session-1")).toBe("openai");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops only the timed-out session's prepared entry", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importPreparedRegistry("openai", "gpt-5.5");
      registry.registerPreparedSession(
        "session-2",
        "anthropic",
        "/other",
        "claude",
      );
      const stuck = deferred<AcpSessionConfigSnapshots>();
      mockSetSessionConfigOption.mockReturnValueOnce(stuck.promise);
      mockInvalidateClientConnection.mockResolvedValueOnce(false);

      const reasoning = registry.applySessionConfigOption(
        "session-1",
        "reasoning_effort",
        "high",
      );
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(reasoning).rejects.toThrow("ACP operation timed out");
      expect(registry.isSessionPrepared("session-1")).toBe(false);
      expect(registry.isSessionPrepared("session-2")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The socket now survives a single timeout, so the timed-out request keeps
  // running and can answer after a newer prepare already configured the
  // session. Its own provider/model must not land in the registry, and the
  // pair the newer prepare recorded can no longer be trusted to skip a
  // `setModel` — the late call may have reached the host after it.
  it("does not let a timed-out prepareSession overwrite a newer one when it answers late", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importRegistry();
      const stuckProvider = deferred<AcpSessionConfigSnapshots>();
      mockLoadSession.mockResolvedValue(undefined);
      mockSetProvider.mockReturnValueOnce(stuckProvider.promise);
      mockInvalidateClientConnection.mockResolvedValue(false);

      const stuck = registry
        .prepareSession("session-1", "openai", "/project")
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await stuck).toMatchObject({
        message: expect.stringContaining("ACP operation timed out"),
      });

      mockSetProvider.mockResolvedValueOnce(
        modelConfigResponse("claude-fable", "Claude Fable"),
      );
      await registry.prepareSession("session-1", "anthropic", "/project");
      expect(registry.getPreparedProviderId("session-1")).toBe("anthropic");

      // The orphan finally answers.
      stuckProvider.resolve(modelConfigResponse("gpt-5.5", "GPT 5.5"));
      await vi.advanceTimersByTimeAsync(0);

      expect(registry.getPreparedProviderId("session-1")).toBe("anthropic");
      // The cached model was dropped, so the model the host is on is asked
      // for over the wire instead of assumed.
      await registry.applySessionModel("session-1", "claude-fable");
      expect(mockSetModel).toHaveBeenCalledWith(
        "session-1",
        "claude-fable",
        noRequestModelContext("anthropic"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a timed-out applySessionModel re-record its model when it answers late", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importPreparedRegistry("openai", "gpt-5.5");
      const stuckModel = deferred<AcpSessionConfigSnapshots>();
      mockSetModel.mockReturnValueOnce(stuckModel.promise);
      mockInvalidateClientConnection.mockResolvedValue(false);

      const stuck = registry
        .applySessionModel("session-1", "gpt-6")
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await stuck).toMatchObject({
        message: expect.stringContaining("ACP operation timed out"),
      });

      mockLoadSession.mockResolvedValueOnce(undefined);
      mockSetProvider.mockResolvedValueOnce(
        modelConfigResponse("gpt-5.5", "GPT 5.5"),
      );
      await registry.prepareSession("session-1", "openai", "/project");

      stuckModel.resolve(modelConfigResponse("gpt-6", "GPT 6"));
      await vi.advanceTimersByTimeAsync(0);

      mockSetModel.mockResolvedValueOnce(
        modelConfigResponse("gpt-5.5", "GPT 5.5"),
      );
      await registry.applySessionModel("session-1", "gpt-5.5");
      expect(mockSetModel).toHaveBeenLastCalledWith(
        "session-1",
        "gpt-5.5",
        noRequestModelContext("openai"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a superseded load pair for the queued model mutation", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);

    const load = registry.loadSession("session-1", "/project");
    const apply = registry.applySessionModel("session-1", "gpt-5.6");
    loadResponse.resolve(executionConfigResponse("openai", "gpt-5.5"));

    await expect(load).resolves.toMatchObject({ isCurrent: false });
    await expect(apply).resolves.toBeUndefined();

    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });

  it("does not run a load between one provider and model configuration", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    const providerResponse = deferred<AcpSessionConfigSnapshots>();
    const modelResponse = deferred<AcpSessionConfigSnapshots>();
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockSetProvider.mockReturnValueOnce(providerResponse.promise);
    mockSetModel.mockReturnValueOnce(modelResponse.promise);
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);

    const configure = registry.configureSession(
      "session-1",
      "anthropic",
      "/project",
      "claude-fable",
    );
    const load = registry.loadSession("session-1", "/project");

    await vi.waitFor(() => expect(mockSetProvider).toHaveBeenCalledTimes(1));
    expect(mockSetModel).not.toHaveBeenCalled();
    expect(mockLoadSession).not.toHaveBeenCalled();

    providerResponse.resolve(
      modelConfigResponse("claude-sonnet", "Claude Sonnet"),
    );
    await vi.waitFor(() => expect(mockSetModel).toHaveBeenCalledTimes(1));
    expect(mockLoadSession).not.toHaveBeenCalled();

    modelResponse.resolve(modelConfigResponse("claude-fable", "Claude Fable"));
    await configure;
    await vi.waitFor(() => expect(mockLoadSession).toHaveBeenCalledTimes(1));

    loadResponse.resolve(executionConfigResponse("anthropic", "claude-fable"));
    await expect(load).resolves.toMatchObject({ isCurrent: true });
    await registry.applySessionModel("session-1", "claude-fable");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("returns the final model snapshot without provider-default fields", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-5.5");
    mockSetProvider.mockResolvedValueOnce(
      modelConfigResponse("claude-sonnet", "Claude Sonnet", {
        configId: "reasoning_effort",
        currentValue: "high",
        options: [{ id: "high", name: "High" }],
      }),
    );
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("claude-fable", "Claude Fable"),
    );

    await expect(
      registry.configureSession(
        "session-1",
        "anthropic",
        "/project",
        "claude-fable",
      ),
    ).resolves.toEqual({
      model: { modelId: "claude-fable", modelName: "Claude Fable" },
      reasoningEffort: null,
    });
  });

  it("invalidates the acknowledged pair when provider setup fails", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetProvider.mockRejectedValueOnce(new Error("snapshot failed"));

    await expect(
      registry.prepareSession("session-1", "anthropic", "/project"),
    ).rejects.toThrow("snapshot failed");

    expect(registry.isSessionPrepared("session-1")).toBe(false);
    await registry.prepareSession("session-1", "openai", "/project");
    expect(mockSetProvider).toHaveBeenLastCalledWith(
      "session-1",
      "openai",
      noRequestProviderContext,
    );
  });

  it("says the provider moved when only the model it was meant to arrive on failed", async () => {
    const registry = await importPreparedRegistry("grok-acp", "grok-4.6");
    const refused = Object.assign(new Error("Internal error"), {
      data: { details: "Invalid value for config option model: spark" },
    });
    mockSetModel.mockRejectedValueOnce(refused);

    const failure = await registry
      .configureSession("session-1", "codex-acp", "/project", "spark")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(registry.ModelFailedAfterProviderMoveError);
    // It reads like the error it wraps, so callers that classify by text or
    // payload see the bridge's own answer.
    expect(failure).toMatchObject({
      providerId: "codex-acp",
      message: "Internal error",
      data: refused.data,
      cause: refused,
    });

    // Nobody holds the model the provider opened the chat on, so settling on
    // that provider asks the host again rather than answering "already there".
    mockSetProvider.mockClear();
    await registry.prepareSession("session-1", "codex-acp", "/project");
    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "codex-acp",
      noRequestProviderContext,
    );
  });

  it("leaves a model failure on the same provider as the error it is", async () => {
    const registry = await importPreparedRegistry("codex-acp", "gpt-6-astra");
    mockSetModel.mockRejectedValueOnce(new Error("refused"));

    const failure = await registry
      .configureSession("session-1", "codex-acp", "/project", "spark")
      .catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(
      registry.ModelFailedAfterProviderMoveError,
    );
    expect(failure).toMatchObject({ message: "refused" });
    // The provider is still known, so nothing is asked of it again.
    mockSetProvider.mockClear();
    await registry.prepareSession("session-1", "codex-acp", "/project");
    expect(mockSetProvider).not.toHaveBeenCalled();
  });

  it("accepts a response that acknowledges the folded form of the request", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("gpt-5.6-sol[ultra]", "GPT-5.6-Sol (ultra)"),
    );

    await expect(
      registry.applySessionModel("session-1", "gpt-5.6-sol"),
    ).resolves.toMatchObject({
      model: { modelId: "gpt-5.6-sol[ultra]" },
    });

    // The acknowledged id is what was cached, so re-applying it is skipped.
    await registry.applySessionModel("session-1", "gpt-5.6-sol[ultra]");
    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("accepts a response that acknowledges the base form of a folded request", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("gpt-5.6-sol", "GPT-5.6-Sol"),
    );

    await expect(
      registry.applySessionModel("session-1", "gpt-5.6-sol[ultra]"),
    ).resolves.toMatchObject({ model: { modelId: "gpt-5.6-sol" } });
    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.6-sol[ultra]",
      noRequestModelContext("openai"),
    );
  });

  it("does not resend a model whose only difference is a legacy folded effort", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");

    await registry.applySessionModel("session-1", "gpt-5.6-sol[low]");
    await registry.applySessionModel("session-1", "gpt-5.6-sol[ultra]");

    // Effort travels on its own channel now, so both ids name one model and
    // only the first reaches the wire.
    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetModel).toHaveBeenLastCalledWith(
      "session-1",
      "gpt-5.6-sol[low]",
      noRequestModelContext("openai"),
    );
  });

  it("rejects a context lane acknowledged as the model without it", async () => {
    const registry = await importPreparedRegistry("anthropic", "sonnet");
    mockSetModel.mockResolvedValueOnce(modelConfigResponse("opus", "Opus 5"));

    await expect(
      registry.applySessionModel("session-1", "opus[1m]"),
    ).rejects.toThrow(
      "ACP acknowledged model opus instead of requested model opus[1m]",
    );
  });

  it("rejects a model response that acknowledges a different model", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("gpt-5.5", "GPT-5.5"),
    );

    await expect(
      registry.applySessionModel("session-1", "gpt-5.6"),
    ).rejects.toThrow(
      "ACP acknowledged model gpt-5.5 instead of requested model gpt-5.6",
    );

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(1);
    await registry.applySessionModel("session-1", "gpt-5.6");
    expect(mockSetModel).toHaveBeenCalledTimes(2);
  });
});

describe("applySessionRunSettings", () => {
  const effortWrite = {
    effort: { configId: "reasoning_effort", value: "high" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSetModel.mockResolvedValue(undefined);
    mockSetProvider.mockResolvedValue(undefined);
    mockSetSessionConfigOption.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockLoadSession.mockResolvedValue(undefined);
    mockInvalidateClientConnection.mockResolvedValue(undefined);
  });

  it("applies provider, then model, then effort, then fast, with the three model-scoped writes under one request id", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    const order: unknown[][] = [];
    const astraMenu = {
      configId: "reasoning_effort",
      currentValue: "medium",
      options: [
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
      ],
    };
    mockSetProvider.mockImplementation(async (_sessionId, providerId) => {
      order.push(["provider", providerId]);
      return modelConfigResponse("gpt-5.5", "GPT-5.5");
    });
    mockSetModel.mockImplementation(async (_sessionId, modelId, context) => {
      order.push(["model", modelId, context.requestId]);
      return modelConfigResponse("gpt-6-astra", "GPT-6-Astra", astraMenu);
    });
    mockSetSessionConfigOption.mockImplementation(
      async (_sessionId, configId, value, context) => {
        order.push([configId, value, context.requestId]);
        return modelConfigResponse("gpt-6-astra", "GPT-6-Astra", {
          ...astraMenu,
          currentValue: "high",
        });
      },
    );
    const planRunSettings = vi.fn(() => ({
      ...effortWrite,
      fast: { configId: "fast-mode", value: true, kind: "select" as const },
    }));

    const snapshots = await registry.configureSession(
      "session-1",
      "codex-acp",
      "/project",
      "gpt-6-astra",
      { requestId: "select-1", planRunSettings },
    );

    // The planner sees the model's own answer, not the provider default's.
    expect(planRunSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: "gpt-6-astra" }),
      }),
    );
    expect(order).toEqual([
      ["provider", "codex-acp"],
      ["model", "gpt-6-astra", "select-1"],
      ["reasoning_effort", "high", "select-1"],
      ["fast-mode", "on", "select-1"],
    ]);
    expect(snapshots?.reasoningEffort?.currentValue).toBe("high");
  });

  it("does not let a prompt run between the model and the effort that follows it", async () => {
    const registry = await importPreparedRegistry("codex-acp", "gpt-5.5");
    const effortAnswer = deferred<AcpSessionConfigSnapshots>();
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("gpt-6-astra", "GPT-6-Astra"),
    );
    mockSetSessionConfigOption.mockReturnValueOnce(effortAnswer.promise);
    const prompt = vi.fn().mockResolvedValue("sent");

    const configure = registry.configureSession(
      "session-1",
      "codex-acp",
      "/project",
      "gpt-6-astra",
      { planRunSettings: () => effortWrite },
    );
    const send = registry.runPreparedSessionPrompt("session-1", prompt);

    await vi.waitFor(() =>
      expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(1),
    );
    expect(prompt).not.toHaveBeenCalled();

    effortAnswer.resolve(modelConfigResponse("gpt-6-astra", "GPT-6-Astra"));
    await configure;
    await expect(send).resolves.toBe("sent");
  });

  it("skips an effort this window already wrote for the current model", async () => {
    const registry = await importPreparedRegistry("codex-acp", "gpt-5.5");

    await registry.applySessionRunSettings("session-1", effortWrite);
    await registry.applySessionRunSettings("session-1", effortWrite);

    expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(1);
  });

  it("writes the same effort again once the session has moved to another model", async () => {
    const registry = await importPreparedRegistry("codex-acp", "gpt-5.5");

    await registry.applySessionRunSettings("session-1", effortWrite);
    await registry.applySessionModel("session-1", "gpt-6-astra");
    await registry.applySessionRunSettings("session-1", effortWrite);

    // A new model answers with its own effort, so nothing written for the
    // previous one counts as acknowledged for it.
    expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(2);
  });

  it("keeps the model applied when the bridge refuses the effort that follows it", async () => {
    const registry = await importPreparedRegistry("codex-acp", "gpt-5.5");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("gpt-6-astra", "GPT-6-Astra"),
    );
    mockSetSessionConfigOption.mockRejectedValueOnce(
      new Error("Invalid params"),
    );

    await expect(
      registry.configureSession(
        "session-1",
        "codex-acp",
        "/project",
        "gpt-6-astra",
        { planRunSettings: () => effortWrite },
      ),
    ).resolves.toMatchObject({ model: { modelId: "gpt-6-astra" } });
    expect(
      registry.requireSessionInvocationSelection("session-1").modelId,
    ).toBe("gpt-6-astra");
  });
});
