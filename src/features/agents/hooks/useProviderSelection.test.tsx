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
    localStorage.clear();
    useProviderCatalogStore.getState().reset();
    // The cases below are about a provider that was chosen at some point.
    useAgentStore.setState({
      providers: [],
      selectedProvider: "claude-acp",
      selectedProviderChosen: true,
    });
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
});
