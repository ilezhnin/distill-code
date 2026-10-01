import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "../api/providerAccounts";

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
  switch: vi.fn(),
  refresh: vi.fn(),
  setDefault: vi.fn(),
  authenticate: vi.fn(),
  setRouting: vi.fn(),
  signOut: vi.fn(),
  update: vi.fn(),
  add: vi.fn(),
}));
vi.mock("../api/providerAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/providerAccounts")>()),
  consumeProviderAccountReset: mocks.reset,
}));
vi.mock("@/shared/api/acpSessionRegistry", () => ({
  setSessionAccount: mocks.switch,
}));
vi.mock("../stores/providerAccountsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/providerAccountsStore")>()),
  startProviderAccountsMonitor: vi.fn(),
}));
import { useProviderAccountsStore } from "../stores/providerAccountsStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useAccountQuotaWaitStore } from "@/features/chat/lib/accountQuotaWait";
import { ProviderAccountsPanel } from "./ProviderAccountsPanel";
import { ProviderAccountPicker } from "./ProviderAccountPicker";

const now = Date.now();
const accounts: ProviderAccount[] = ["Personal", "Work"].map((label) => ({
  id: label.toLowerCase(),
  providerId: "codex-acp",
  label,
  authMethod: "oauth",
  enabled: true,
  autoSwitch: true,
  createdAt: now,
  updatedAt: now,
}));
function status(
  accountId: string,
  resetTokens: ProviderAccountStatus["resetTokens"] = null,
): ProviderAccountStatus {
  return {
    accountId,
    providerId: "codex-acp",
    state: "ready",
    subscription: "Pro",
    accountLabel: null,
    limits: [],
    resetTokens,
    credits: null,
    lastUpdatedAt: now,
    lastAttemptAt: now,
    stale: false,
    error: null,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ sessionStateById: {} });
  useAccountQuotaWaitStore.setState({ waits: {} });
  mocks.refresh.mockResolvedValue(undefined);
  useProviderAccountsStore.setState({
    accounts,
    defaults: { "codex-acp": "personal" },
    automaticSwitching: {},
    statuses: { personal: status("personal"), work: status("work") },
    loaded: true,
    refreshing: false,
    error: null,
    refresh: mocks.refresh,
    setDefault: mocks.setDefault,
    authenticate: mocks.authenticate,
    setRouting: mocks.setRouting,
    signOut: mocks.signOut,
    update: mocks.update,
    add: mocks.add,
    authStates: {},
  });
  useChatSessionStore.setState({
    sessions: [
      {
        id: "chat",
        title: "Chat",
        accountId: "personal",
        createdAt: "2026-09-28",
        updatedAt: "2026-09-28",
        messageCount: 2,
      },
    ],
  });
});
afterEach(cleanup);

describe("account surfaces", () => {
  it.each([
    "Codex",
    "Claude Code",
  ])("starts an empty %s group through subscription sign-in", async (provider) => {
    useProviderAccountsStore.setState({
      accounts: [],
      defaults: {},
      statuses: {},
    });
    const providerId = provider === "Codex" ? "codex-acp" : "claude-acp";
    mocks.add.mockResolvedValueOnce({ ...accounts[0], providerId });
    render(<ProviderAccountsPanel />);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("region", { name: provider })).getByRole(
        "button",
        { name: "Add account" },
      ),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("combobox")).toHaveTextContent(
      "Subscription",
    );
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Personal" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add and sign in" }),
    );
    await waitFor(() =>
      expect(mocks.authenticate).toHaveBeenCalledWith("personal"),
    );
    expect(mocks.add).toHaveBeenCalledWith({
      providerId,
      label: "Personal",
      authMethod: "oauth",
    });
  });

  it("lets an unassigned chat choose an account without following the new-chat default", async () => {
    useChatSessionStore.getState().patchSession("chat", { accountId: null });
    mocks.switch.mockResolvedValueOnce({});
    render(
      <ProviderAccountPicker
        providerId="codex-acp"
        sessionId="chat"
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Choose a connected account to continue this chat. Your conversation will be kept.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Selected" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Use account" })[0]);
    await waitFor(() =>
      expect(mocks.switch).toHaveBeenCalledWith("chat", "personal"),
    );
    expect(mocks.setDefault).not.toHaveBeenCalled();
  });
  it("controls each provider group with one switch and keeps account cards switch-free", async () => {
    mocks.setRouting.mockImplementation(async (providerId, enabled) => {
      useProviderAccountsStore.setState((state) => ({
        automaticSwitching: {
          ...state.automaticSwitching,
          [providerId]: enabled,
        },
      }));
    });
    render(<ProviderAccountsPanel />);
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    for (const card of screen.getAllByRole("article")) {
      expect(within(card).queryByRole("switch")).not.toBeInTheDocument();
    }
    const codex = screen.getByRole("switch", {
      name: "Auto-switch Codex accounts",
    });
    const claude = screen.getByRole("switch", {
      name: "Auto-switch Claude Code accounts",
    });
    fireEvent.click(codex);
    await waitFor(() => expect(codex).toBeChecked());
    expect(claude).not.toBeChecked();
    expect(mocks.setRouting).toHaveBeenLastCalledWith("codex-acp", true);
    await waitFor(() => expect(codex).toBeEnabled());
    fireEvent.click(claude);
    await waitFor(() => expect(claude).toBeChecked());
    expect(mocks.setRouting).toHaveBeenLastCalledWith("claude-acp", true);
    fireEvent.click(codex);
    await waitFor(() => expect(codex).not.toBeChecked());
    expect(claude).toBeChecked();
    expect(mocks.setRouting).toHaveBeenLastCalledWith("codex-acp", false);
  });

  it("keeps the provider switch unchanged when saving fails", async () => {
    mocks.setRouting.mockRejectedValueOnce(new Error("Cannot save routing"));
    render(<ProviderAccountsPanel />);
    const codex = screen.getByRole("switch", {
      name: "Auto-switch Codex accounts",
    });
    fireEvent.click(codex);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Cannot save routing",
      ),
    );
    expect(codex).not.toBeChecked();
    expect(codex).toBeEnabled();
  });

  it("refreshes telemetry errors without forcing browser sign-in", () => {
    useProviderAccountsStore.setState({
      statuses: {
        personal: { ...status("personal"), state: "error", error: "Offline" },
      },
    });
    render(<ProviderAccountsPanel />);
    const card = screen.getByRole("article", { name: "Personal" });
    expect(
      within(card).queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Refresh" }));
    expect(mocks.refresh).toHaveBeenCalledWith(true);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("checks saved credentials on sign-in without edit or remove controls", () => {
    useProviderAccountsStore.setState({
      statuses: { personal: { ...status("personal"), state: "needs_auth" } },
    });
    render(<ProviderAccountsPanel />);
    const card = screen.getByRole("article", { name: "Personal" });
    fireEvent.click(within(card).getByRole("button", { name: "Sign in" }));
    expect(mocks.authenticate).toHaveBeenCalledWith("personal");
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("signs out only the selected profile and preserves its chat", async () => {
    mocks.signOut.mockResolvedValueOnce(undefined);
    render(<ProviderAccountsPanel />);
    const card = screen.getByRole("article", { name: "Personal" });
    fireEvent.click(within(card).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith("personal"));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(useChatSessionStore.getState().getSession("chat")?.accountId).toBe(
      "personal",
    );
    expect(
      within(card).queryByRole("button", { name: "Default" }),
    ).not.toBeInTheDocument();
    expect(within(card).getByText("Default")).toBeInTheDocument();
  });

  it("keeps a failed sign-out visible and allows retry", async () => {
    mocks.signOut.mockRejectedValueOnce(new Error("Account is running a turn"));
    render(<ProviderAccountsPanel />);
    const card = screen.getByRole("article", { name: "Work" });
    fireEvent.click(within(card).getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(within(card).getByRole("alert")).toHaveTextContent(
        "Account is running a turn",
      ),
    );
    expect(
      within(card).getByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
  });

  it("offers the same subscription sign-in for every signed-out account", () => {
    useProviderAccountsStore.setState({
      accounts: [accounts[0]],
      statuses: { personal: { ...status("personal"), state: "needs_auth" } },
    });
    render(<ProviderAccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mocks.authenticate).toHaveBeenCalledWith("personal");
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
  });

  it("uses fresh account status after completing browser sign-in", () => {
    useProviderAccountsStore.setState({
      authStates: {
        personal: { accountId: "personal", status: "needs_auth", message: "" },
      },
    });
    render(<ProviderAccountsPanel />);
    const card = screen.getByRole("article", { name: "Personal" });
    expect(
      within(card).getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(
      within(card).queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
  });

  it("shows a reported identity once and signs an API profile back in with a new key", async () => {
    useProviderAccountsStore.setState({
      accounts: [
        { ...accounts[0], label: "person@example.test", authMethod: "api_key" },
      ],
      statuses: {
        personal: {
          ...status("personal"),
          accountLabel: "person@example.test",
          state: "needs_auth",
        },
      },
    });
    mocks.update.mockResolvedValueOnce(undefined);
    render(<ProviderAccountsPanel />);
    expect(screen.getAllByText("person@example.test")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const dialog = screen.getByRole("dialog", { name: "Sign in to Codex" });
    const submit = within(dialog).getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("API key"), {
      target: { value: "test-key" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("personal", {
        apiKey: "test-key",
      }),
    );
  });

  it("names the planned account while keeping the current chat account unchanged", () => {
    useAccountQuotaWaitStore.setState({
      waits: {
        chat: {
          accountId: "work",
          startedAt: now,
          retryAt: now + 60_000,
          message: "Waiting",
          resetTokensAvailable: false,
        },
      },
    });
    render(
      <ProviderAccountPicker
        providerId="codex-acp"
        sessionId="chat"
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking Work again");
    expect(useChatSessionStore.getState().getSession("chat")?.accountId).toBe(
      "personal",
    );
  });

  it("does not switch while the active turn waits for tool approval", () => {
    useChatStore.getState().setChatState("chat", "waiting");
    render(
      <ProviderAccountPicker
        providerId="codex-acp"
        sessionId="chat"
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Use account" })).toBeDisabled();
  });
  it("shows every account with unknown limits and does not invent reset actions", () => {
    render(<ProviderAccountsPanel />);
    expect(
      screen.getByRole("article", { name: "Personal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Work" })).toBeInTheDocument();
    expect(screen.getAllByText("Reset tokens: Not reported")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Use a reset token" }),
    ).not.toBeInTheDocument();
  });

  it("only sends a reset after confirmation and keeps one idempotency key on uncertain retry", async () => {
    useProviderAccountsStore.setState({
      statuses: {
        personal: status("personal", {
          available: 1,
          supported: true,
          expiresAt: null,
        }),
      },
    });
    mocks.reset
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    render(<ProviderAccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Use a reset token" }));
    expect(mocks.reset).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Use one reset token?" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use one token" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Connection lost",
      ),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use one token" }),
    );
    await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(2));
    expect(mocks.reset.mock.calls[0]).toEqual(mocks.reset.mock.calls[1]);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(true));
  });

  it("switches only the selected chat after the backend succeeds", async () => {
    mocks.switch.mockResolvedValue({});
    render(
      <ProviderAccountPicker
        providerId="codex-acp"
        sessionId="chat"
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use account" }));
    await waitFor(() =>
      expect(useChatSessionStore.getState().getSession("chat")?.accountId).toBe(
        "work",
      ),
    );
    expect(mocks.switch).toHaveBeenCalledWith("chat", "work");
    expect(mocks.setDefault).not.toHaveBeenCalled();
  });

  it("keeps the previous selection and displays a failed switch", async () => {
    mocks.switch.mockRejectedValue(
      new Error("Model unavailable on this account"),
    );
    render(
      <ProviderAccountPicker
        providerId="codex-acp"
        sessionId="chat"
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use account" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Model unavailable"),
    );
    expect(useChatSessionStore.getState().getSession("chat")?.accountId).toBe(
      "personal",
    );
  });

  it("keeps account status available during a turn while disabling account changes", () => {
    render(
      <ProviderAccountPicker
        providerId="codex-acp"
        sessionId="chat"
        disabled
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Use account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });
});
