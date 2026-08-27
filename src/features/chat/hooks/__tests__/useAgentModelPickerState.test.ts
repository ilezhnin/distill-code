import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useAgentModelPickerState } from "../useAgentModelPickerState";

const mockUseProviderModels = vi.fn();
const mockRefreshAgentProviderStatus = vi.fn();
const mockUseAgentProviderStatus = vi.fn();

vi.mock("@/features/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({
    isModelInventoryAuthoritative: () => false,
    getInstalledModelsForAgent: () => [],
    getModelInventoryProblem: () => null,
    ...mockUseProviderModels(),
  }),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => mockUseAgentProviderStatus(),
}));

describe("useAgentModelPickerState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderCatalogStore.getState().reset();
    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: [],
      modelCacheRefreshProviderIds: [],
      getModelsForAgent: () => [],
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
    });
    mockRefreshAgentProviderStatus.mockResolvedValue(undefined);
    mockUseAgentProviderStatus.mockReturnValue({
      readyAgentIds: new Set([
        "goose",
        "codex-acp",
        "cursor-agent",
        "claude-acp",
        "grok-acp",
      ]),
      agentReadiness: new Map([
        ["goose", "ready"],
        ["codex-acp", "ready"],
        ["cursor-agent", "ready"],
        ["claude-acp", "ready"],
        ["grok-acp", "ready"],
      ]),
      loading: false,
      refresh: mockRefreshAgentProviderStatus,
    });
  });

  // Three situations used to reach the pill as the same empty list: a poll
  // that never came back, a provider that answered with no models, and a
  // provider that has none. The pill now names which one it is looking at.
  it.each([
    {
      what: "a poll that never came back",
      problem: {
        providerId: "openrouter",
        outcome: "failed" as const,
        reason: "bridge is not running",
      },
      expected: "Could not ask openrouter for models: bridge is not running",
    },
    {
      what: "a poll that came back naming nothing",
      problem: { providerId: "openrouter", outcome: "empty" as const },
      expected: "openrouter reported no models",
    },
  ])("reports $what in the model status message", ({ problem, expected }) => {
    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: ["openrouter"],
      modelCacheRefreshProviderIds: ["openrouter"],
      getModelsForAgent: () => [],
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
      getModelInventoryProblem: () => problem,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [],
        selectedProvider: "goose",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(result.current.modelStatusMessage).toBe(expected);
  });

  it("leaves the status message empty once models are listed", () => {
    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: ["openrouter"],
      modelCacheRefreshProviderIds: ["openrouter"],
      getModelsForAgent: () => [
        {
          id: "openrouter-model",
          name: "openrouter-model",
          displayName: "OpenRouter Model",
          providerId: "openrouter",
          providerName: "OpenRouter",
          recommended: false,
        },
      ],
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
      getModelInventoryProblem: () => ({
        providerId: "openrouter",
        outcome: "empty" as const,
      }),
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [],
        selectedProvider: "goose",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(result.current.modelStatusMessage).toBeNull();
  });

  it("switches to goose when requested", () => {
    const onProviderSelected = vi.fn();

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [{ id: "goose", label: "Goose" }],
        selectedProvider: "databricks_v2",
        onProviderSelected,
      }),
    );

    act(() => {
      result.current.handleProviderChange("goose");
    });

    expect(onProviderSelected).toHaveBeenCalledWith("goose", []);
  });

  it("treats goose as a no-op only when goose is already selected", () => {
    const onProviderSelected = vi.fn();

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [],
        selectedProvider: "goose",
        onProviderSelected,
      }),
    );

    act(() => {
      result.current.handleProviderChange("goose");
    });

    expect(onProviderSelected).not.toHaveBeenCalled();
  });

  it("passes the selected model provider through for goose model picks", () => {
    const onModelSelected = vi.fn();
    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: ["databricks_v2"],
      modelCacheRefreshProviderIds: ["databricks_v2"],
      getModelsForAgent: () => [
        {
          id: "claude-sonnet-4",
          name: "claude-sonnet-4",
          displayName: "Claude Sonnet 4",
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          recommended: true,
        },
      ],
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [{ id: "goose", label: "Goose" }],
        selectedProvider: "databricks_v2",
        onProviderSelected: vi.fn(),
        onModelSelected,
      }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    expect(onModelSelected).toHaveBeenCalledWith({
      id: "claude-sonnet-4",
      name: "claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      provider: undefined,
      providerId: "databricks_v2",
      providerName: "Databricks AI Gateway",
      recommended: true,
    });
  });

  it("uses the clicked model when multiple providers expose the same model id", () => {
    const onModelSelected = vi.fn();
    const customModel = {
      id: "llama3.2",
      name: "llama3.2",
      displayName: "llama3.2",
      providerId: "custom_ollama",
      providerName: "Custom Ollama",
    };

    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: ["ollama", "custom_ollama"],
      modelCacheRefreshProviderIds: ["ollama", "custom_ollama"],
      getModelsForAgent: () => [
        {
          id: "llama3.2",
          name: "llama3.2",
          displayName: "llama3.2",
          providerId: "ollama",
          providerName: "Ollama",
        },
        customModel,
      ],
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [{ id: "goose", label: "Goose" }],
        selectedProvider: "ollama",
        onProviderSelected: vi.fn(),
        onModelSelected,
      }),
    );

    act(() => {
      result.current.handleModelChange("llama3.2", customModel);
    });

    expect(onModelSelected).toHaveBeenCalledWith({
      id: "llama3.2",
      name: "llama3.2",
      displayName: "llama3.2",
      provider: undefined,
      providerId: "custom_ollama",
      providerName: "Custom Ollama",
      recommended: undefined,
    });
  });

  it("routes model providers through Goose", () => {
    const getModelsForAgent = vi.fn((agentId: string) =>
      agentId === "goose"
        ? [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              providerId: "databricks_v2",
              providerName: "Databricks AI Gateway",
            },
          ]
        : [],
    );

    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: ["databricks_v2"],
      modelCacheRefreshProviderIds: ["databricks_v2"],
      getModelsForAgent,
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [{ id: "goose", label: "Goose" }],
        selectedProvider: "databricks_v2",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(result.current.selectedAgentId).toBe("goose");
    expect(getModelsForAgent).toHaveBeenCalledWith("goose");
    expect(
      result.current.availableModels.map((model) => model.providerId),
    ).toEqual(["databricks_v2"]);
  });

  it("preserves curated agent providers", () => {
    const getModelsForAgent = vi.fn(() => [
      {
        id: "current",
        name: "Current",
        providerId: "codex-acp",
        providerName: "Codex",
      },
    ]);

    mockUseProviderModels.mockReturnValue({
      configuredModelProviderIds: [],
      modelCacheRefreshProviderIds: ["codex-acp"],
      getModelsForAgent,
      refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
      isRefreshingProvider: () => false,
      getError: () => null,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [{ id: "codex-acp", label: "Codex" }],
        selectedProvider: "codex-acp",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(result.current.selectedAgentId).toBe("codex-acp");
    expect(getModelsForAgent).toHaveBeenCalledWith("codex-acp");
  });

  it("shows curated agent providers", () => {
    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [
          { id: "codex-acp", label: "Codex" },
          { id: "cursor-agent", label: "Cursor" },
        ],
        selectedProvider: "goose",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(result.current.pickerAgents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([
        "goose",
        "claude-acp",
        "codex-acp",
        "grok-acp",
        "cursor-agent",
      ]),
    );
    expect(result.current.pickerAgents.map((agent) => agent.id)).not.toEqual(
      expect.arrayContaining(["copilot-acp", "amp-acp"]),
    );
    expect(
      result.current.pickerAgents.find((agent) => agent.id === "codex-acp"),
    ).toMatchObject({ id: "codex-acp", label: "Codex", readiness: "ready" });
  });

  it("hides catalog harnesses that are not connected", () => {
    mockUseAgentProviderStatus.mockReturnValue({
      readyAgentIds: new Set(["goose", "cursor-agent"]),
      agentReadiness: new Map([
        ["goose", "ready"],
        ["codex-acp", "not_installed"],
        ["cursor-agent", "ready"],
      ]),
      loading: false,
      refresh: mockRefreshAgentProviderStatus,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [
          { id: "codex-acp", label: "Codex" },
          { id: "cursor-agent", label: "Cursor" },
        ],
        selectedProvider: "goose",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(
      result.current.pickerAgents.find((agent) => agent.id === "codex-acp"),
    ).toBeUndefined();
    expect(
      result.current.pickerAgents.find((agent) => agent.id === "cursor-agent"),
    ).toMatchObject({
      id: "cursor-agent",
      label: "Cursor Agent",
      readiness: "ready",
    });
  });

  it("keeps Goose visible when it is selected and still needs setup", () => {
    mockUseAgentProviderStatus.mockReturnValue({
      readyAgentIds: new Set(["codex-acp"]),
      agentReadiness: new Map([
        ["goose", "not_ready"],
        ["codex-acp", "ready"],
      ]),
      loading: false,
      refresh: mockRefreshAgentProviderStatus,
    });

    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [{ id: "codex-acp", label: "Codex" }],
        selectedProvider: "goose",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(
      result.current.pickerAgents.find((agent) => agent.id === "goose"),
    ).toEqual({
      id: "goose",
      label: "Goose",
      readiness: "not_ready",
      setupAction: "connect",
    });
    expect(
      result.current.pickerAgents.find((agent) => agent.id === "codex-acp"),
    ).toMatchObject({ id: "codex-acp", label: "Codex", readiness: "ready" });
  });

  it("still lists connected catalog harnesses when startup has not populated providers", () => {
    const { result } = renderHook(() =>
      useAgentModelPickerState({
        providers: [],
        selectedProvider: "claude-acp",
        onProviderSelected: vi.fn(),
      }),
    );

    expect(result.current.pickerAgents.map((agent) => agent.id)).toEqual([
      "goose",
      "claude-acp",
      "codex-acp",
      "grok-acp",
      "cursor-agent",
    ]);
  });
});
