import { describe, expect, it } from "vitest";
import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { listVisibleAgentPickerOptions } from "./listVisibleAgentPickerOptions";

describe("listVisibleAgentPickerOptions", () => {
  it("lists connected catalog harnesses even with an empty store snapshot", () => {
    const agents = listVisibleAgentPickerOptions({
      catalogEntries: CURATED_PROVIDER_CATALOG,
      catalogLoaded: true,
      agentReadiness: new Map([
        ["goose", "ready"],
        ["claude-acp", "ready"],
        ["codex-acp", "ready"],
        ["grok-acp", "ready"],
      ]),
      extraProviders: [],
      selectedAgentId: "claude-acp",
      readyAgentIds: new Set(["goose", "claude-acp", "codex-acp", "grok-acp"]),
    });

    expect(agents.map((agent) => agent.id)).toEqual([
      "goose",
      "claude-acp",
      "codex-acp",
      "grok-acp",
    ]);
  });

  it("hides uninstalled harnesses and Goose without a model provider", () => {
    const agents = listVisibleAgentPickerOptions({
      catalogEntries: CURATED_PROVIDER_CATALOG,
      catalogLoaded: true,
      agentReadiness: new Map([
        ["goose", "not_ready"],
        ["claude-acp", "ready"],
        ["codex-acp", "ready"],
        ["grok-acp", "ready"],
        ["cursor-agent", "not_installed"],
        ["copilot-acp", "not_installed"],
        ["amp-acp", "not_installed"],
      ]),
      extraProviders: [],
      selectedAgentId: "grok-acp",
      readyAgentIds: new Set(["claude-acp", "codex-acp", "grok-acp"]),
    });

    expect(agents.map((agent) => agent.id)).toEqual([
      "claude-acp",
      "codex-acp",
      "grok-acp",
    ]);
  });

  it("keeps an installed harness that needs reconnect, instead of hiding it", () => {
    const agents = listVisibleAgentPickerOptions({
      catalogEntries: CURATED_PROVIDER_CATALOG,
      catalogLoaded: true,
      agentReadiness: new Map([
        ["goose", "not_ready"],
        ["claude-acp", "not_ready"],
        ["codex-acp", "ready"],
        ["grok-acp", "ready"],
        ["cursor-agent", "not_installed"],
        ["copilot-acp", "not_installed"],
        ["amp-acp", "not_installed"],
      ]),
      extraProviders: [],
      selectedAgentId: "codex-acp",
      readyAgentIds: new Set(["codex-acp", "grok-acp"]),
    });

    expect(agents.map((agent) => agent.id)).toEqual([
      "claude-acp",
      "codex-acp",
      "grok-acp",
    ]);
    expect(agents.find((agent) => agent.id === "claude-acp")).toMatchObject({
      readiness: "not_ready",
      setupAction: "connect",
    });
  });

  it("keeps the selected harness visible even when it is not ready", () => {
    const agents = listVisibleAgentPickerOptions({
      catalogEntries: CURATED_PROVIDER_CATALOG,
      catalogLoaded: true,
      agentReadiness: new Map([
        ["goose", "not_ready"],
        ["codex-acp", "ready"],
      ]),
      extraProviders: [],
      selectedAgentId: "goose",
      readyAgentIds: new Set(["codex-acp"]),
    });

    expect(agents.map((agent) => agent.id)).toEqual(["goose", "codex-acp"]);
    expect(agents.find((agent) => agent.id === "goose")).toMatchObject({
      readiness: "not_ready",
      setupAction: "connect",
    });
  });

  it("keeps ready store extras that are not in the catalog", () => {
    const agents = listVisibleAgentPickerOptions({
      catalogEntries: CURATED_PROVIDER_CATALOG,
      catalogLoaded: true,
      agentReadiness: new Map([
        ["goose", "ready"],
        ["custom-acp", "ready"],
      ]),
      extraProviders: [{ id: "custom-acp", label: "Custom" }],
    });

    expect(agents.map((agent) => agent.id)).toContain("custom-acp");
    expect(agents.find((agent) => agent.id === "custom-acp")).toMatchObject({
      id: "custom-acp",
      label: "Custom",
      readiness: "ready",
    });
  });
});
