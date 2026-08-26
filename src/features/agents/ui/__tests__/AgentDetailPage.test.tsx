import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { renderWithProviders } from "@/test/render";
import type { Persona } from "@/shared/types/agents";

import { AgentDetailPage } from "../AgentDetailPage";

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMedia: () => undefined,
  useAvatarImage: () => undefined,
}));

// The avatar picker pulls in the Tauri dialog plugin; keep it inert in jsdom.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

// Markdown rendering is irrelevant here and drags in the streaming renderer.
vi.mock("@/shared/ui/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    displayName: "Custom Helper",
    systemPrompt: "Help carefully.",
    isBuiltin: false,
    writable: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderPage(persona: Persona) {
  return renderWithProviders(
    <AgentDetailPage
      persona={persona}
      onBack={vi.fn()}
      onEdit={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      onExport={vi.fn()}
      onAvatarUpdate={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("AgentDetailPage", () => {
  it("shows the model ranking instead of the legacy Provider/Model pair", () => {
    renderPage(makePersona({ provider: "grok-acp", model: "grok-4-6" }));

    // The legacy single-selection block is gone from the profile…
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    // …and the ranking summary stands in its place, showing the saved
    // single model as the list's only row rather than claiming no ranking.
    expect(screen.getByText("Model ranking")).toBeInTheDocument();
    const rows = screen.getAllByTestId("agent-ranking-summary-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("grok-4-6");
  });

  it("renders the agent's own ranking when one is stored", () => {
    renderPage(
      makePersona({
        modelRanking: JSON.stringify({
          version: 1,
          entries: [
            {
              platform: "claude-acp",
              modelId: "claude-fable-5",
              label: "Fable 5",
              effort: "xhigh",
            },
          ],
        }),
      }),
    );

    const rows = screen.getAllByTestId("agent-ranking-summary-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Fable 5");
  });
});
