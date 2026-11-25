import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatInput } from "../ChatInput";

vi.mock("@/features/providers/hooks/useAccountModels", () => ({
  useAccountModels: () => ({ loading: false, error: null, models: null }),
}));
vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["claude-acp"]),
    agentReadiness: new Map([["claude-acp", "ready"]]),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
});

/** A queued message under a chat whose agent is still on a turn. */
function renderWaitingComposer(canSteerMessage: boolean) {
  return render(
    <ChatInput
      composerActions={{
        onSend: vi.fn(),
        isStreaming: true,
        canSteerMessage,
        queuedMessage: { persona: { kind: "none" }, text: "queued msg" },
      }}
      agentModelPicker={{
        providers: [{ id: "claude-acp", label: "Claude Code" }],
        selectedProvider: "claude-acp",
      }}
    />,
  );
}

function turnWaitLine(): string | null {
  const line =
    document.querySelector<HTMLElement>(
      '[data-slot="queued-message-waits-for-turn"]',
    ) ??
    document.querySelector<HTMLElement>(
      '[data-slot="queued-message-no-steering"]',
    );
  return line?.textContent ?? null;
}

it("control: a queued message for an agent that cannot steer says it waits for the current turn", () => {
  renderWaitingComposer(false);
  expect(turnWaitLine()).toBe(
    "Claude Code gets this message when its current turn ends. Press Esc to stop the turn and send it now.",
  );
});

it("a queued message for an agent that can steer also says it waits for the current turn", () => {
  renderWaitingComposer(true);
  expect(turnWaitLine()).toBe(
    "Claude Code gets this message when its current turn ends. Steer sends it into the turn now.",
  );
});
