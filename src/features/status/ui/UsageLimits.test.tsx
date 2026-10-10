import { render, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "@/features/providers/api/providerAccounts";
import { ProviderAccountDetails } from "@/features/providers/ui/ProviderAccountDetails";
import { accountUsage } from "../lib/accountUsage";
import { ProviderDetailsPanel } from "./ProviderDetailsPanel";

const now = Date.UTC(2026, 8, 29, 12);
const account: ProviderAccount = {
  id: "personal",
  providerId: "claude-acp",
  label: "Personal",
  authMethod: "oauth",
  enabled: true,
  autoSwitch: true,
  createdAt: now,
  updatedAt: now,
};
const status: ProviderAccountStatus = {
  accountId: account.id,
  providerId: account.providerId,
  state: "ready",
  subscription: "pro",
  accountLabel: "Personal",
  resetTokens: null,
  credits: null,
  lastUpdatedAt: now,
  lastAttemptAt: now,
  stale: false,
  error: null,
  limits: [
    {
      id: "session:0",
      label: "session",
      usedPercent: 17,
      remaining: 83,
      windowMinutes: 300,
      modelId: null,
      resetsAt: now + 4 * 3600000,
    },
    {
      id: "weekly_all:1",
      label: "weekly_all",
      usedPercent: 19,
      remaining: 81,
      windowMinutes: 10080,
      modelId: null,
      resetsAt: now + 6 * 86400000,
    },
    {
      id: "monthly:2",
      label: "43200 min",
      usedPercent: 72,
      remaining: 28,
      windowMinutes: 43200,
      modelId: null,
      resetsAt: now + 20 * 86400000,
    },
  ],
};

it.each([
  "codex-acp",
  "claude-acp",
  "zai-acp",
])("uses identical quota rows in %s settings and status details", (providerId) => {
  const selected = { ...account, providerId };
  const selectedStatus = { ...status, providerId };
  const [usage] = accountUsage({
    accounts: [selected],
    defaults: { [providerId]: selected.id },
    statuses: { [selected.id]: selectedStatus },
    automaticSwitching: {},
  });
  const { getByTestId } = render(
    <>
      <div data-testid="account">
        <ProviderAccountDetails
          account={selected}
          status={selectedStatus}
          now={now}
        />
      </div>
      <div data-testid="status">
        <ProviderDetailsPanel provider={usage} now={now} />
      </div>
    </>,
  );
  const rows = (name: string) =>
    within(getByTestId(name))
      .getAllByRole("progressbar")
      .map((bar) => ({
        label: bar.getAttribute("aria-label"),
        percent: bar.getAttribute("aria-valuenow"),
        text: bar.parentElement?.textContent,
      }));
  expect(rows("account")).toEqual(rows("status"));
  expect(rows("account")).toEqual([
    { label: "5 hours", percent: "17", text: "5 hours17% usedResets in 4h" },
    { label: "Weekly", percent: "19", text: "Weekly19% usedResets in 6d" },
    { label: "Monthly", percent: "72", text: "Monthly72% usedResets in 20d" },
  ]);
  for (const name of ["account", "status"]) {
    expect(getByTestId(name)).not.toHaveTextContent(
      /weekly_all|43200 min|remaining/,
    );
    expect(within(getByTestId(name)).getByText("Resets in 4h")).toHaveAttribute(
      "datetime",
      new Date(now + 4 * 3600000).toISOString(),
    );
  }
});

it("clears displayed usage on sign-out without showing a fabricated zero", () => {
  const { queryByRole, getByText } = render(
    <ProviderAccountDetails
      account={account}
      status={{ ...status, state: "needs_auth" }}
      now={now}
    />,
  );
  expect(queryByRole("progressbar")).not.toBeInTheDocument();
  expect(getByText("Sign-in required")).toBeInTheDocument();
});

it("labels a model-specific monthly window without losing its scope", () => {
  const { getByRole } = render(
    <ProviderAccountDetails
      account={account}
      status={{
        ...status,
        limits: [{ ...status.limits[2], modelId: "Test model" }],
      }}
      now={now}
    />,
  );
  expect(
    getByRole("progressbar", { name: "Test model · Monthly" }),
  ).toHaveAttribute("aria-valuenow", "72");
});

it("shows a provider pause as a live countdown instead of a failed refresh", () => {
  const [usage] = accountUsage({
    accounts: [account],
    defaults: { [account.providerId]: account.id },
    automaticSwitching: {},
    statuses: {
      [account.id]: {
        ...status,
        state: "error",
        stale: true,
        error: "Claude usage requests are paused by the provider.",
        usageRetryAt: now + 90_000,
      },
    },
  });
  const paused = render(<ProviderDetailsPanel provider={usage} now={now} />);
  expect(paused.getByText("Usage requests paused")).toBeInTheDocument();
  expect(paused.getByText("Retry in 1:30")).toBeInTheDocument();
  expect(paused.queryByText(/Refresh failed/)).not.toBeInTheDocument();
  expect(
    paused.queryByText("Claude usage requests are paused by the provider."),
  ).not.toBeInTheDocument();
  paused.rerender(
    <ProviderDetailsPanel provider={usage} now={now + 120_000} />,
  );
  expect(
    paused.getByText("Waiting for the next usage update"),
  ).toBeInTheDocument();
});
