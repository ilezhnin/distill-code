import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { useAgentStore } from "../agentStore";

describe("agentStore.setProviders", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({
      providers: [],
      providersLoading: false,
      selectedProvider: "claude-acp",
    });
    localStorage.setItem("distill:defaultProvider", "claude-acp");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("does not overwrite stored provider during unvalidated hydration", () => {
    useAgentStore
      .getState()
      .setProviders([{ id: "goose", label: "Goose" }], false);

    expect(useAgentStore.getState().selectedProvider).toBe("claude-acp");
    expect(localStorage.getItem("distill:defaultProvider")).toBe("claude-acp");
  });

  it("falls back and persists when validated and provider is missing", () => {
    useAgentStore
      .getState()
      .setProviders([{ id: "goose", label: "Goose" }], true);

    expect(useAgentStore.getState().selectedProvider).toBe("goose");
    expect(localStorage.getItem("distill:defaultProvider")).toBe("goose");
  });

  it("keeps valid provider during validated hydration", () => {
    useAgentStore.getState().setProviders(
      [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      true,
    );

    expect(useAgentStore.getState().selectedProvider).toBe("claude-acp");
    expect(localStorage.getItem("distill:defaultProvider")).toBe("claude-acp");
  });
});
