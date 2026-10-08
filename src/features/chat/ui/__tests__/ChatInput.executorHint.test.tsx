import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { ChatInput } from "../ChatInput";
import type { ModelOption } from "../../types";

const accountModels = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  models: [
    { id: "account-model", name: "Account model", providerId: "codex-acp" },
  ] as ModelOption[],
}));
vi.mock("@/features/providers/hooks/useAccountModels", () => ({
  useAccountModels: () => accountModels,
}));
vi.mock("@/features/providers/ui/ProviderAccountPicker", () => ({
  ProviderAccountPicker: () => null,
}));
vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["codex-acp"]),
    agentReadiness: new Map([["codex-acp", "ready"]]),
    refresh: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  useProviderAccountsStore.setState({ accounts: [], defaults: {} });
  accountModels.error = null;
  accountModels.loading = false;
});

it("forwards the preview through the composer with the selected account inventory", async () => {
  useProviderAccountsStore.setState({
    accounts: [
      {
        id: "example-account",
        providerId: "codex-acp",
        label: "Example",
        authMethod: "oauth",
        enabled: true,
        autoSwitch: false,
        createdAt: 0,
        updatedAt: 1,
      },
    ],
    defaults: { "codex-acp": "example-account" },
  });
  const user = userEvent.setup();
  const read = vi.fn(async () => null);
  const send = vi.fn();
  const picker = {
    providers: [{ id: "codex-acp", label: "Codex" }],
    selectedProvider: "codex-acp",
    availableModels: [{ id: "wrong-account-model", name: "Wrong account" }],
    readExecutorSuggestion: read,
  };
  const { rerender } = render(
    <ChatInput composerActions={{ onSend: send }} agentModelPicker={picker} />,
  );
  expect(read).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Choose agent and model" }),
  );
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith({
      harnessId: "codex-acp",
      accountId: "example-account",
      models: accountModels.models,
    }),
  );
  expect(send).not.toHaveBeenCalled();
  // A failed account refresh must not fall back to the provider's cached menu.
  accountModels.error = "inventory failed";
  rerender(
    <ChatInput composerActions={{ onSend: send }} agentModelPicker={picker} />,
  );
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith({
      harnessId: "codex-acp",
      accountId: "example-account",
      models: [],
    }),
  );
  expect(send).not.toHaveBeenCalled();
});
