import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { ModelOption } from "@/features/chat/types";
import { renderWithProviders } from "@/test/render";

import { serializeAgentModelRanking } from "../../../lib/agentModelRanking";
import { ModelRankingField } from "../ModelRankingField";

const inventory = vi.hoisted(
  (): Record<string, ModelOption[]> => ({
    "claude-acp": [
      {
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
          { id: "max", name: "Max" },
        ],
        defaultEffort: "high",
        supportsFast: false,
      },
      {
        id: "claude-opus-5",
        name: "Opus 5",
        efforts: [{ id: "xhigh", name: "Extra high" }],
        supportsFast: true,
      },
    ],
    "grok-acp": [{ id: "grok-4.6", name: "Grok 4.6", supportsFast: false }],
  }),
);

vi.mock("@/features/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({
    getModelsForAgent: (provider: string) => inventory[provider] ?? [],
    getModelInventoryProblem: () => null,
  }),
}));

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

describe("ModelRankingField", () => {
  it("offers a fast switch only on a row whose model has fast mode", () => {
    useAgentStore.setState({
      providers: [
        { id: "claude-acp", label: "Claude Code" },
        { id: "grok-acp", label: "Grok" },
      ],
    });
    renderWithProviders(
      <ModelRankingField
        value={serializeAgentModelRanking({
          version: 1,
          entries: [
            {
              platform: "claude-acp",
              modelId: "claude-opus-4-6",
              label: "Opus 4.6",
            },
            {
              platform: "claude-acp",
              modelId: "claude-opus-5",
              label: "Opus 5",
            },
            { platform: "grok-acp", modelId: "grok-4.6", label: "Grok 4.6" },
          ],
        })}
        onChange={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId("model-ranking-row");
    expect(within(rows[0]).queryByTestId("model-ranking-fast")).toBeNull();
    expect(within(rows[1]).getByTestId("model-ranking-fast")).toBeTruthy();
    expect(within(rows[2]).queryByTestId("model-ranking-fast")).toBeNull();
  });

  it("previews what runs when the picked model does not offer the ranked effort", () => {
    useAgentStore.setState({
      providers: [{ id: "claude-acp", label: "Claude Code" }],
    });
    renderWithProviders(
      <ModelRankingField
        value={serializeAgentModelRanking({
          version: 1,
          entries: [
            {
              platform: "claude-acp",
              modelId: "claude-opus-4-6",
              label: "Opus 4.6",
              effort: "xhigh",
            },
          ],
        })}
        onChange={vi.fn()}
      />,
    );

    const preview = screen.getByTestId("model-ranking-preview").textContent;
    expect(preview).toContain("Opus 4.6");
    expect(preview).toContain("xhigh");
    expect(preview).toContain("high");
    expect(preview).not.toBe("Right now: Opus 4.6 · xhigh");
  });

  it("survives the operator typing a name that is an Object.prototype member", () => {
    // The field derives the role class from the live name field while the
    // operator is still typing. "Constructor" slugs to `constructor`, which a
    // plain-object lookup used to find on the prototype — and the builder
    // crashed on the keystroke.
    for (const displayName of ["Constructor", "ToString", "__proto__"]) {
      const { unmount } = renderWithProviders(
        <ModelRankingField
          value=""
          onChange={vi.fn()}
          displayName={displayName}
        />,
      );
      expect(screen.getByTestId("model-ranking-field")).toBeTruthy();
      expect(screen.queryByTestId("model-ranking-fill")).toBeNull();
      unmount();
    }
  });
});
