import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatSession,
  type ChatSessionReasoningEffortConfig,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { reconcileSessionRunSettings } from "../runSettingsReconciler";

const mocks = vi.hoisted(() => ({
  applyRunSettings: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpApplySessionRunSettings: (...args: unknown[]) =>
    mocks.applyRunSettings(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  setSessionConfigOption: (...args: unknown[]) =>
    mocks.setSessionConfigOption(...args),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  invalidateClientConnectionIfUnresponsive: vi.fn(),
}));

const SESSION_ID = "session-1";

function effortMenu(
  configId: string,
  ids: string[],
  currentValue: string,
): ChatSessionReasoningEffortConfig {
  return {
    configId,
    currentValue,
    options: ids.map((id) => ({ id, name: id })),
  };
}

function seedSession(overrides: Partial<ChatSession>): void {
  useChatSessionStore.setState({
    sessions: [
      {
        id: SESSION_ID,
        title: "Chat",
        createdAt: "2026-09-13T00:00:00Z",
        updatedAt: "2026-09-13T00:00:00Z",
        messageCount: 0,
        executionTargetSource: "ui",
        ...overrides,
      },
    ],
  });
}

function switchModel(harnessId: string, modelId: string, modelName: string) {
  useChatSessionStore.getState().replaceSessionExecutionTarget(SESSION_ID, {
    harnessId,
    modelProviderId: harnessId,
    modelId,
    modelName,
  });
}

function session(): ChatSession | undefined {
  return useChatSessionStore.getState().getSession(SESSION_ID);
}

describe("reconcileSessionRunSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatSessionStore.setState({ sessions: [] });
    mocks.applyRunSettings.mockResolvedValue(undefined);
  });

  it("writes nothing when codex moves from astra at max to gpt-5.5, and names the clamp the host reported", async () => {
    seedSession({
      executionTarget: {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "gpt-6-astra",
        modelName: "GPT-6-Astra",
      },
      desiredRunSettings: { effort: "max" },
      reasoningEffort: effortMenu(
        "reasoning_effort",
        ["low", "medium", "high", "xhigh", "max", "ultra"],
        "max",
      ),
    });

    switchModel("codex-acp", "gpt-5.5", "GPT-5.5");
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      reasoningEffort: effortMenu(
        "reasoning_effort",
        ["low", "medium", "high", "xhigh"],
        "medium",
      ),
    });
    await reconcileSessionRunSettings({
      sessionId: SESSION_ID,
      substitutions: [
        {
          role: "effort",
          requested: "max",
          applied: "medium",
          reason: "not offered by gpt-5.5",
        },
      ],
    });

    expect(mocks.applyRunSettings).not.toHaveBeenCalled();
    expect(session()?.runSettingsNotice).toEqual({
      kind: "effort",
      wanted: "max",
      actual: "medium",
      modelName: "GPT-5.5",
    });
    expect(session()?.desiredRunSettings).toEqual({ effort: "max" });
  });

  it("puts xhigh back on opus after the session passed through haiku", async () => {
    const opusMenu = ["default", "low", "medium", "high", "xhigh", "max"];
    seedSession({
      executionTarget: {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "opus[1m]",
        modelName: "Opus 5",
      },
      desiredRunSettings: { effort: "xhigh" },
      reasoningEffort: effortMenu("effort", opusMenu, "xhigh"),
    });

    switchModel("claude-acp", "haiku", "Haiku 4.5");
    await reconcileSessionRunSettings({ sessionId: SESSION_ID });

    expect(mocks.applyRunSettings).not.toHaveBeenCalled();
    expect(session()?.runSettingsNotice).toEqual({
      kind: "effort",
      wanted: "xhigh",
      actual: null,
      modelName: "Haiku 4.5",
    });

    switchModel("claude-acp", "opus[1m]", "Opus 5");
    // The bridge reports "default" here: it lost the effort on the way.
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      reasoningEffort: effortMenu("effort", opusMenu, "default"),
    });
    mocks.applyRunSettings.mockResolvedValueOnce({
      model: { modelId: "opus[1m]", modelName: "Opus 5" },
      reasoningEffort: effortMenu("effort", opusMenu, "xhigh"),
      fastMode: null,
    });
    await reconcileSessionRunSettings({ sessionId: SESSION_ID });

    expect(mocks.applyRunSettings).toHaveBeenCalledTimes(1);
    expect(mocks.applyRunSettings).toHaveBeenCalledWith(
      SESSION_ID,
      { effort: { configId: "effort", value: "xhigh" } },
      expect.objectContaining({ modelId: "opus[1m]" }),
    );
    expect(session()?.runSettingsNotice).toBeFalsy();
    expect(session()?.reasoningEffort?.currentValue).toBe("xhigh");
  });

  it("keeps fast intent through a model without fast mode and turns it back on when the option returns", async () => {
    seedSession({
      executionTarget: {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "opus[1m]",
        modelName: "Opus 5",
      },
      desiredRunSettings: { fast: true },
      fastMode: { configId: "fast", enabled: true, kind: "select" },
    });

    switchModel("claude-acp", "sonnet", "Sonnet 5");
    await reconcileSessionRunSettings({ sessionId: SESSION_ID });

    expect(mocks.applyRunSettings).not.toHaveBeenCalled();
    expect(session()?.fastMode).toBeUndefined();
    expect(session()?.desiredRunSettings).toEqual({ fast: true });
    expect(session()?.runSettingsNotice).toEqual({
      kind: "fast",
      wanted: "on",
      actual: null,
      modelName: "Sonnet 5",
    });

    switchModel("claude-acp", "opus[1m]", "Opus 5");
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      fastMode: { configId: "fast", enabled: false, kind: "select" },
    });
    await reconcileSessionRunSettings({ sessionId: SESSION_ID });

    expect(mocks.applyRunSettings).toHaveBeenCalledWith(
      SESSION_ID,
      { fast: { configId: "fast", value: true, kind: "select" } },
      expect.objectContaining({ modelId: "opus[1m]" }),
    );
    expect(session()?.runSettingsNotice).toBeFalsy();
  });

  it("does not say anything about fast off on a model that has no fast mode", async () => {
    seedSession({
      executionTarget: {
        harnessId: "grok-acp",
        modelProviderId: "grok-acp",
        modelId: "grok-4.6",
        modelName: "Grok 4.6",
      },
      desiredRunSettings: { fast: false },
    });

    await reconcileSessionRunSettings({
      sessionId: SESSION_ID,
      substitutions: [{ role: "fast", requested: "off", applied: null }],
    });

    expect(mocks.applyRunSettings).not.toHaveBeenCalled();
    expect(session()?.runSettingsNotice).toBeUndefined();
  });

  it("writes a grok effort once even when grok echoes the change back as a notification", async () => {
    const registry = await import("@/shared/api/acpSessionRegistry");
    mocks.applyRunSettings.mockImplementation(
      (...args: Parameters<typeof registry.applySessionRunSettings>) =>
        registry.applySessionRunSettings(...args),
    );
    const grokMenu = ["low", "medium", "high", "xhigh"];
    mocks.setSessionConfigOption.mockResolvedValue({
      model: { modelId: "grok-4.6", modelName: "Grok 4.6" },
      reasoningEffort: effortMenu("reasoning_effort", grokMenu, "high"),
      fastMode: null,
    });
    registry.registerPreparedSession(
      SESSION_ID,
      "grok-acp",
      "/project",
      "grok-4.6",
    );
    seedSession({
      executionTarget: {
        harnessId: "grok-acp",
        modelProviderId: "grok-acp",
        modelId: "grok-4.6",
        modelName: "Grok 4.6",
      },
      desiredRunSettings: { effort: "high" },
      reasoningEffort: effortMenu("reasoning_effort", grokMenu, "medium"),
    });

    await reconcileSessionRunSettings({ sessionId: SESSION_ID });
    // grok's own config_option_update for the same write, reconciled against
    // the menu as it was before the answer landed.
    await reconcileSessionRunSettings({
      sessionId: SESSION_ID,
      menus: {
        reasoningEffort: effortMenu("reasoning_effort", grokMenu, "medium"),
      },
    });
    await reconcileSessionRunSettings({ sessionId: SESSION_ID });

    expect(mocks.setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(mocks.setSessionConfigOption).toHaveBeenCalledWith(
      SESSION_ID,
      "reasoning_effort",
      "high",
      expect.objectContaining({ reasoningEffortValue: "high" }),
    );
    expect(session()?.reasoningEffort?.currentValue).toBe("high");
  });
});
