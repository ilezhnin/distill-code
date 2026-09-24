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
