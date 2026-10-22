import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { resetUsageLedgerForTests } from "@/features/stats/lib/usageLedger";
import { buildProviderStatuses } from "./providerStatus";
import {
  isListedUsageProvider,
  platformLimitState,
  getUsageSections,
} from "./rateLimitWindows";
import { getProviderUsageStatusKind } from "./rateLimitFormatters";

const future: ProviderCatalogEntry = {
  id: "future-acp",
  displayName: "Future Provider",
  category: "agent",
  description: "Test provider",
  setupMethod: "cli_auth",
  group: "default",
  aliases: ["future"],
  supportsAuth: true,
  supportsAuthStatus: true,
  supportsInstall: true,
};

afterEach(() => {
  useProviderCatalogStore.getState().reset();
  resetUsageLedgerForTests();
});

describe("catalog provider participation", () => {
  it("keeps signed-out and missing providers distinct without requiring a quota adapter", () => {
    const [signedOut] = buildProviderStatuses(
      [future],
      [],
      new Map([[future.id, "not_ready"]]),
    );
    expect(getProviderUsageStatusKind(signedOut)).toBe("sign-in");
    expect(isListedUsageProvider(signedOut, "not_ready", true)).toBe(true);
    const [missing] = buildProviderStatuses(
      [future],
      [],
      new Map([[future.id, "not_installed"]]),
    );
    expect(isListedUsageProvider(missing, "not_installed", false)).toBe(false);
    expect(buildProviderStatuses([future], [], new Map())[0].status).toBe(
      "idle",
    );
  });

  it("does not list an installed provider whose sign-in never completed", () => {
    // An abandoned setup installs the CLI and stops before sign-in: Doctor
    // reports it installed but not ready, and nothing was ever connected.
    const [abandoned] = buildProviderStatuses(
      [future],
      [],
      new Map([[future.id, "not_ready"]]),
    );
    expect(isListedUsageProvider(abandoned, "not_ready", false)).toBe(false);
    const [connected] = buildProviderStatuses(
      [future],
      [],
      new Map([[future.id, "ready"]]),
    );
    // Installed and ready, but nothing signed in: no account, no usage, no
    // earlier connection, so the bar has nothing to report for it.
    expect(isListedUsageProvider(connected, "ready", false)).toBe(false);
    expect(
      isListedUsageProvider(
        { ...connected, accountId: "acct-1" },
        "ready",
        false,
      ),
    ).toBe(true);
    expect(isListedUsageProvider(connected, "ready", true)).toBe(true);
    // A provider whose adapter reports no usage has no row, even with the
    // account row the host's status read produced for it.
    expect(
      isListedUsageProvider(
        { ...connected, accountId: "acct-1" },
        "ready",
        true,
        false,
      ),
    ).toBe(false);
  });

  it("uses monthly coding constraints alongside shorter Kimi quota windows", () => {
    const window = {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null,
    };
    const [usage] = buildProviderStatuses(
      [future],
      [
        {
          provider: future.id,
          session: window,
          weekly: window,
          monthly: { ...window, usedPercent: 80, windowMinutes: 43200 },
          codingMonthly: { ...window, usedPercent: 100, windowMinutes: 43200 },
          status: "ok",
          configured: true,
          error: null,
          updatedAt: 1,
        },
      ],
      new Map([[future.id, "ready"]]),
    );
    expect(getUsageSections(usage).map((section) => section.key)).toEqual([
      "session",
      "weekly",
      "monthly",
      "codingMonthly",
    ]);
    expect(platformLimitState([usage], future.id)).toBe("at-limit");
    const [signedOut] = buildProviderStatuses(
      [future],
      [usage],
      new Map([[future.id, "not_ready"]]),
    );
    expect(getUsageSections(signedOut)).toEqual([]);
    expect(getProviderUsageStatusKind(signedOut)).toBe("sign-in");
  });
});
