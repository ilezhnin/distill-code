import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { formatDate } from "@/shared/i18n";
import {
  type AccountQuotaWait,
  clearAccountQuotaWait,
  useAccountQuotaWaitStore,
} from "../../lib/accountQuotaWait";
import { useChatStore } from "../../stores/chatStore";
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

const SESSION_ID = "quota-parked-chat";

beforeEach(() => {
  useProviderAccountsStore.setState({
    accounts: [
      {
        id: "work",
        providerId: "claude-acp",
        label: "Work",
        authMethod: "oauth",
        enabled: true,
        autoSwitch: true,
        createdAt: 0,
        updatedAt: 1,
      },
    ],
    defaults: { "claude-acp": "work" },
  });
});

afterEach(() => {
  cleanup();
  clearAccountQuotaWait(SESSION_ID);
  useProviderAccountsStore.setState({ accounts: [], defaults: {} });
  useChatStore.setState({ sessionStateById: {} });
  vi.useRealTimers();
});

/** Parks the chat's queue the way `deferForAccountQuota` does on a 429. */
function parkOnQuota(
  wait: Pick<AccountQuotaWait, "retryAt" | "resetAt"> &
    Partial<AccountQuotaWait>,
) {
  useAccountQuotaWaitStore.setState({
    waits: {
      [SESSION_ID]: {
        startedAt: Date.now(),
        message: "Waiting",
        accountId: "work",
        providerId: "claude-acp",
        resetTokensAvailable: false,
        ...wait,
      },
    },
  });
  useChatStore.getState().setAccountQuotaWaitUntil(SESSION_ID, wait.retryAt);
}

function renderQueuedComposer() {
  return render(
    <ChatInput
      composerActions={{
        onSend: vi.fn(),
        queuedMessage: { persona: { kind: "none" }, text: "queued msg" },
      }}
      agentModelPicker={{
        accountSessionId: SESSION_ID,
        providers: [{ id: "claude-acp", label: "Claude Code" }],
        selectedProvider: "claude-acp",
      }}
    />,
  );
}

function waitLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="queued-message-quota-wait"]',
  );
}

it("names the spent account and the re-check time while no reset is known", () => {
  const retryAt = Date.now() + 60_000;
  parkOnQuota({ retryAt, resetAt: null });

  renderQueuedComposer();

  expect(screen.getByText("queued msg")).toBeInTheDocument();
  const line = waitLine();
  expect(line).not.toBeNull();
  expect(line).toHaveTextContent(
    /^Claude Code account Work is out of quota\. Checking again at .+ \(in 1m\)\.$/,
  );
  expect(line).toHaveTextContent(formatDate(retryAt, { timeStyle: "short" }));
});

it("waits until the provider's reset once the host names it", () => {
  const resetAt = Date.now() + 2 * 60 * 60_000 + 5 * 60_000;
  parkOnQuota({ retryAt: resetAt + 1000, resetAt, accountId: undefined });

  renderQueuedComposer();

  const line = waitLine();
  expect(line).toHaveTextContent(
    /^Claude Code is out of quota until the reset at .+ \(in 2h 5m\)\.$/,
  );
  expect(line).toHaveTextContent(
    formatDate(resetAt + 1000, { timeStyle: "short" }),
  );
});

it("counts the wait down every minute", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T12:00:00"));
  const resetAt = Date.now() + 30 * 60_000;
  parkOnQuota({ retryAt: resetAt + 1000, resetAt });

  renderQueuedComposer();
  expect(waitLine()).toHaveTextContent("(in 30m)");

  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(waitLine()).toHaveTextContent("(in 29m)");
});

it("drops the line as soon as the wait clears and keeps the queued pill", () => {
  parkOnQuota({ retryAt: Date.now() + 60_000, resetAt: null });
  renderQueuedComposer();
  expect(waitLine()).not.toBeNull();

  act(() => {
    clearAccountQuotaWait(SESSION_ID);
  });

  expect(waitLine()).toBeNull();
  expect(screen.getByText("queued msg")).toBeInTheDocument();
});
