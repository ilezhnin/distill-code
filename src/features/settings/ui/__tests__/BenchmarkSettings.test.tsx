import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderAccount } from "@/features/providers/api/providerAccounts";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { renderWithProviders } from "@/test/render";

import { BenchmarkSettings } from "../BenchmarkSettings";

const mocks = vi.hoisted(() => ({
  copyKeyToSandbox: vi.fn(),
  getCreditSpend: vi.fn(),
}));

vi.mock("@/features/benchmarks/api/benchmarks", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/benchmarks/api/benchmarks")
    >();
  return {
    ...actual,
    benchmarkApi: {
      ...actual.benchmarkApi,
      copyKeyToSandbox: mocks.copyKeyToSandbox,
      getCreditSpend: mocks.getCreditSpend,
    },
  };
});
vi.mock(
  "@/features/providers/stores/providerAccountsStore",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/providers/stores/providerAccountsStore")
    >()),
    startProviderAccountsMonitor: vi.fn(),
  }),
);

function account(
  id: string,
  providerId: string,
  label: string,
): ProviderAccount {
  return {
    id,
    providerId,
    label,
    authMethod: providerId === "zai-acp" ? "api_key" : "oauth",
    enabled: true,
    autoSwitch: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function showAccounts(accounts: ProviderAccount[]) {
  useProviderAccountsStore.setState({
    accounts,
    defaults: {},
    automaticSwitching: {},
    statuses: {},
    authStates: {},
    loaded: true,
    refreshing: false,
    error: null,
  });
}

function row(label: string) {
  const element = screen
    .getByText(label)
    .closest<HTMLElement>('[data-slot="settings-row"]');
  if (!element) throw new Error(`No settings row for ${label}`);
  return within(element);
}

const COPY = "Copy key to benchmark sandbox";

describe("BenchmarkSettings Z.ai sandbox keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCreditSpend.mockResolvedValue({ limit: null, spent: 0 });
  });

  it("copies each Z.ai account's key into the sandbox and says so", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    mocks.copyKeyToSandbox.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    showAccounts([
      account("zai-1", "zai-acp", "Coding Plan Lite"),
      account("zai-2", "zai-acp", "Coding Plan Pro"),
      account("codex-1", "codex-acp", "Work Codex"),
    ]);
    renderWithProviders(<BenchmarkSettings />);

    expect(
      screen.getByRole("heading", {
        name: "Z.ai keys in the benchmark sandbox",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: COPY })).toHaveLength(2);
    expect(screen.queryByText("Work Codex")).not.toBeInTheDocument();
    expect(
      row("Coding Plan Lite").getByText(
        /Copy it again after you change the key/,
      ),
    ).toBeInTheDocument();

    await user.click(
      row("Coding Plan Pro").getByRole("button", { name: COPY }),
    );

    expect(mocks.copyKeyToSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.copyKeyToSandbox).toHaveBeenCalledWith("zai-acp", "zai-2");
    const pending = await row("Coding Plan Pro").findByRole("button", {
      name: /Copying/,
    });
    expect(pending).toBeDisabled();

    finish();

    expect(await row("Coding Plan Pro").findByRole("status")).toHaveTextContent(
      "Key copied to the benchmark sandbox.",
    );
    expect(
      row("Coding Plan Lite").queryByRole("status"),
    ).not.toBeInTheDocument();
  });

  it("shows why a copy failed and lets it be tried again", async () => {
    const user = userEvent.setup();
    mocks.copyKeyToSandbox
      .mockRejectedValueOnce({
        code: "infrastructure_failure",
        message: "bench-login zai exited with status 1",
      })
      .mockResolvedValueOnce(undefined);
    showAccounts([account("zai-1", "zai-acp", "Coding Plan Lite")]);
    renderWithProviders(<BenchmarkSettings />);

    const lite = row("Coding Plan Lite");
    await user.click(lite.getByRole("button", { name: COPY }));

    expect(await lite.findByRole("alert")).toHaveTextContent(
      "Not copied: bench-login zai exited with status 1",
    );

    await user.click(lite.getByRole("button", { name: COPY }));

    expect(await lite.findByRole("status")).toHaveTextContent(
      "Key copied to the benchmark sandbox.",
    );
    expect(lite.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.copyKeyToSandbox).toHaveBeenCalledTimes(2);
  });

  it("says there is no Z.ai account instead of offering a copy", () => {
    showAccounts([account("codex-1", "codex-acp", "Work Codex")]);
    renderWithProviders(<BenchmarkSettings />);

    expect(
      row("No Z.ai Coding Plan accounts").getByText(/under AI providers/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: COPY }),
    ).not.toBeInTheDocument();
  });
});
