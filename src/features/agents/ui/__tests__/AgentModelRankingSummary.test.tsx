import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import type { Persona } from "@/shared/types/agents";

import { serializeAgentModelRanking } from "../../lib/agentModelRanking";
import { AgentModelRankingSummary } from "../AgentModelRankingSummary";

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    displayName: "Custom Helper",
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("AgentModelRankingSummary", () => {
  it("renders the agent's own ranking rows in order, with efforts", () => {
    renderWithProviders(
      <AgentModelRankingSummary
        persona={makePersona({
          modelRanking: serializeAgentModelRanking({
            version: 1,
            entries: [
              {
                platform: "claude-acp",
                modelId: "claude-fable-5",
                label: "Fable 5",
                effort: "xhigh",
              },
              {
                platform: "grok-acp",
                modelId: "grok-4-6",
                label: "Grok 4.6",
              },
            ],
          }),
        })}
      />,
    );

    const rows = screen.getAllByTestId("agent-ranking-summary-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Fable 5");
    expect(rows[0]).toHaveTextContent("xhigh");
    expect(rows[1]).toHaveTextContent("Grok 4.6");
    // An explicit list needs no origin note.
    expect(screen.queryByTestId("agent-ranking-summary-note")).toBeNull();
  });

  it("shows the role's built-in order for an untuned role-classed agent", () => {
    // "Acceptor" maps to the bundled testing-heavy class, which the runtime
    // walks before ever considering the single model.
    renderWithProviders(
      <AgentModelRankingSummary
        persona={makePersona({ displayName: "Acceptor" })}
      />,
    );

    const rows = screen.getAllByTestId("agent-ranking-summary-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveTextContent("Fable 5");
    expect(screen.getByTestId("agent-ranking-summary-note")).toHaveTextContent(
      "role",
    );
  });

  it("names the legacy single model as the fallback under a role order", () => {
    renderWithProviders(
      <AgentModelRankingSummary
        persona={makePersona({
          displayName: "Acceptor",
          provider: "grok-acp",
          model: "grok-4-6",
        })}
      />,
    );

    // The old Provider/Model pair must not silently vanish from the page: it
    // is still the runtime's fallback when nothing ranked is usable.
    expect(
      screen.getByTestId("agent-ranking-summary-fallback"),
    ).toHaveTextContent("grok-4-6");
  });

  it("shows a lone legacy single model as the only row, marked as such", () => {
    renderWithProviders(
      <AgentModelRankingSummary
        persona={makePersona({ provider: "grok-acp", model: "grok-4-6" })}
      />,
    );

    const rows = screen.getAllByTestId("agent-ranking-summary-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("grok-4-6");
    // Not "no ranking": the single model IS the preference; the note says
    // where it comes from instead of lying about an empty ranking.
    expect(screen.getByTestId("agent-ranking-summary-note")).toHaveTextContent(
      "single model",
    );
  });

  it("says so when the agent has no preference at all", () => {
    renderWithProviders(<AgentModelRankingSummary persona={makePersona()} />);

    expect(
      screen.getByTestId("agent-ranking-summary-none"),
    ).toBeInTheDocument();
  });
});
