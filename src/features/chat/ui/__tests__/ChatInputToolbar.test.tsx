import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatInput } from "./chatInputTestUtils";

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["claude-acp", "codex-acp", "grok-acp"]),
    agentReadiness: new Map([
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
      ["grok-acp", "ready"],
    ]),
    loading: false,
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
});

describe("ChatInputToolbar session cost", () => {
  it("shows estimated cost in the default color with a short hint in the name", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        contextTokens={1200}
        contextLimit={200000}
        isContextUsageReady
        accumulatedCost={6.28}
      />,
    );

    const amount = screen.getByText("$6.28");
    expect(amount).toHaveAttribute("data-cost-billing", "estimate");
    expect(amount).not.toHaveClass("text-destructive");
    expect(
      screen.getByRole("button", {
        name: "Context usage, session cost $6.28, est. · not billed",
      }),
    ).toBeInTheDocument();
  });

  it("marks billed cost in destructive red without a composer prefix", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        contextTokens={1200}
        contextLimit={200000}
        isContextUsageReady
        accumulatedCost={6.28}
        costBilling="billed"
      />,
    );

    const amount = screen.getByText("$6.28");
    expect(amount).toHaveAttribute("data-cost-billing", "billed");
    expect(amount).toHaveClass("text-destructive");
    expect(amount).toHaveTextContent("$6.28");
    expect(amount.textContent).toBe("$6.28");
    expect(
      screen.getByRole("button", {
        name: "Context usage, session cost $6.28, API bill",
      }),
    ).toBeInTheDocument();
  });
});
