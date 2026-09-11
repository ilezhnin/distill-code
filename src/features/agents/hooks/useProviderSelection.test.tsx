import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../stores/agentStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderSelection } from "./useProviderSelection";

const mockReadyAgentIds = vi.hoisted(() => ({
  value: new Set<string>(["claude-acp"]),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: mockReadyAgentIds.value,
    agentReadiness: new Map(),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("useProviderSelection", () => {
  beforeEach(() => {
    mockReadyAgentIds.value = new Set<string>(["claude-acp"]);
    useProviderCatalogStore.getState().reset();
    useAgentStore.setState({ providers: [], selectedProvider: "claude-acp" });
  });

  it("keeps a ready catalog provider as the stored value", () => {
    mockReadyAgentIds.value = new Set(["claude-acp", "codex-acp"]);
    useAgentStore.setState({ selectedProvider: "codex-acp" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("codex-acp");
  });

  it("keeps a catalogued provider as the persisted preference", () => {
    mockReadyAgentIds.value = new Set(["claude-acp"]);
    useAgentStore.setState({ selectedProvider: "codex-acp" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("codex-acp");
  });

  it("keeps the default harness as the persisted preference when another agent is ready", () => {
    mockReadyAgentIds.value = new Set(["codex-acp"]);
    useAgentStore.setState({ selectedProvider: "claude-acp" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("claude-acp");
  });

  it("falls an unknown provider back to the default harness once the catalog is loaded", () => {
    useAgentStore.setState({ selectedProvider: "ghost-provider" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("claude-acp");
  });

  it("keeps an unknown provider while the catalog has not loaded", () => {
    useProviderCatalogStore.setState({ loaded: false });
    useAgentStore.setState({ selectedProvider: "ghost-provider" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("ghost-provider");
  });

  it("keeps the default harness as the default harness", () => {
    useAgentStore.setState({ selectedProvider: "claude-acp" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("claude-acp");
  });
});
