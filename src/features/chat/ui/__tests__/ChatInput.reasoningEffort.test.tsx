import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChatInput } from "../ChatInput";

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["claude-acp", "zai-acp", "kimi-acp"]),
    agentReadiness: new Map(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/features/providers/hooks/useAccountModels", () => ({
  useAccountModels: () => ({ models: null, loading: false, error: null }),
}));

afterEach(cleanup);

it.each([
  "zai-acp",
  "kimi-acp",
  "codex-acp",
])("does not expose Claude's synthetic effort for %s, even when already armed", async (harnessId) => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const setArmed = vi.fn();
  render(
    <ChatInput
      composerActions={{ onSend: vi.fn() }}
      agentModelPicker={{ selectedProvider: harnessId }}
      reasoningEffort={{
        config: {
          configId: "effort",
          currentValue: "max",
          options: [
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
            { id: "max", name: "Max" },
          ],
        },
        onChange,
        ultracode: { armed: true, setArmed },
      }}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Reasoning effort: Max" }),
  );
  expect(screen.queryByText("Ultracode")).not.toBeInTheDocument();
  expect(
    screen
      .getAllByRole("radio")
      .map((radio) => radio.getAttribute("aria-label")),
  ).toEqual(["Low", "High", "Max"]);
  await user.click(screen.getByRole("radio", { name: "High" }));
  expect(onChange).toHaveBeenCalledWith("high");
  expect(setArmed).not.toHaveBeenCalled();
});

it("keeps Ultracode on Claude and removes it immediately when switching to GLM", async () => {
  const user = userEvent.setup();
  const reasoningEffort = {
    config: {
      configId: "effort",
      currentValue: "high",
      options: [
        { id: "high", name: "High" },
        { id: "max", name: "Max" },
      ],
    },
    onChange: vi.fn(),
    ultracode: { armed: false, setArmed: vi.fn() },
  };
  const props = { composerActions: { onSend: vi.fn() }, reasoningEffort };
  const { rerender } = render(
    <ChatInput
      {...props}
      agentModelPicker={{ selectedProvider: "claude-acp" }}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Reasoning effort: High" }),
  );
  await user.click(screen.getByRole("radio", { name: "Ultracode" }));
  expect(reasoningEffort.onChange).toHaveBeenCalledWith("max");
  expect(reasoningEffort.ultracode.setArmed).toHaveBeenCalledWith(true);
  rerender(
    <ChatInput {...props} agentModelPicker={{ selectedProvider: "zai-acp" }} />,
  );
  expect(screen.queryByText("Ultracode")).not.toBeInTheDocument();
});
