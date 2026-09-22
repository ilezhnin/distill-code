import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatInput } from "./chatInputTestUtils";
import userEvent from "@testing-library/user-event";

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

describe("ChatInputToolbar fast mode", () => {
  it("offers Fast immediately after effort before a live session exists, preserving intent", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProvider="codex-acp"
        currentModelId="gpt-6-sol"
        availableModels={[
          { id: "gpt-6-sol", name: "6 Sol", supportsFast: true },
        ]}
        reasoningEffort={{
          config: {
            configId: "reasoning_effort",
            currentValue: "high",
            options: [
              { id: "low", name: "Low" },
              { id: "high", name: "High" },
            ],
          },
          onChange: vi.fn(),
        }}
        fastMode={{ desired: true, onChange }}
      />,
    );
    const effort = screen.getByRole("button", {
      name: "Reasoning effort: High",
    });
    const fast = screen.getByRole("button", { name: "Fast", pressed: true });
    expect(
      effort.compareDocumentPosition(fast) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(fast);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("uses the live acknowledged value and respects the disabled composer", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const props = {
      onSend: vi.fn(),
      fastMode: {
        desired: true,
        config: {
          configId: "fast",
          name: "Fast",
          enabled: false,
          kind: "select" as const,
        },
        onChange,
      },
    };
    const view = render(<ChatInput {...props} />);
    await user.click(
      screen.getByRole("button", { name: "Fast", pressed: false }),
    );
    expect(onChange).toHaveBeenCalledWith(true);
    view.rerender(<ChatInput {...props} disabled />);
    expect(screen.getByRole("button", { name: "Fast" })).toBeDisabled();
  });

  it("does not invent a speed toggle for Grok's separate Fast model", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProvider="grok-acp"
        currentModelId="grok-4.7-build-fast"
        availableModels={[
          {
            id: "grok-4.7-build-fast",
            name: "Grok 4.7 Fast",
            supportsFast: false,
          },
        ]}
        fastMode={{ onChange: vi.fn() }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Fast" })).toBeNull();
  });
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
