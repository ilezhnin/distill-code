import { describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import type { ProviderRateLimits } from "@/features/status/lib/rateLimitTypes";
import {
  applyUsageAuthReadiness,
  applyManagedAccountReadiness,
  readinessFromReport,
} from "../useAgentProviderStatus";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "../../api/providerAccounts";

describe("managed account readiness", () => {
  const account: ProviderAccount = {
    id: "managed",
    providerId: "codex-acp",
    label: "Managed",
    authMethod: "oauth",
    enabled: true,
    autoSwitch: true,
    createdAt: 0,
    updatedAt: 0,
  };
  const status: ProviderAccountStatus = {
    accountId: "managed",
    providerId: "codex-acp",
    state: "ready",
    subscription: null,
    accountLabel: null,
    limits: [],
    resetTokens: null,
    credits: null,
    lastUpdatedAt: Date.now(),
    lastAttemptAt: Date.now(),
    stale: false,
    error: null,
  };
  it("keeps an installed provider usable through a saved account when the system CLI is signed out", () => {
    const readiness = new Map([["codex-acp", "not_ready" as const]]);
    expect(
      applyManagedAccountReadiness(readiness, [account], {
        managed: status,
      }).get("codex-acp"),
    ).toBe("ready");
    expect(readiness.get("codex-acp")).toBe("not_ready");
  });
  it("does not hide a missing bridge or invent readiness for revoked accounts", () => {
    expect(
      applyManagedAccountReadiness(
        new Map([["codex-acp", "not_installed"]]),
        [account],
        { managed: status },
      ).get("codex-acp"),
    ).toBe("not_installed");
    expect(
      applyManagedAccountReadiness(
        new Map([["codex-acp", "not_ready"]]),
        [account],
        { managed: { ...status, state: "needs_auth" } },
      ).get("codex-acp"),
    ).toBe("not_ready");
  });
  it("ignores external CLI sign-in when Distill has no connected account", () => {
    const readiness = new Map([["codex-acp", "ready" as const]]);
    expect(
      applyManagedAccountReadiness(readiness, [], {}).get("codex-acp"),
    ).toBe("not_ready");
    expect(
      applyManagedAccountReadiness(readiness, [account], {
        managed: { ...status, state: "needs_auth" },
      }).get("codex-acp"),
    ).toBe("not_ready");
    expect(readiness.get("codex-acp")).toBe("ready");
  });
  it("keeps a saved account connected when its quota refresh is rate limited", () => {
    expect(
      applyManagedAccountReadiness(
        new Map([["codex-acp", "ready"]]),
        [account],
        {
          managed: {
            ...status,
            state: "error",
            stale: true,
            error: "HTTP 429",
          },
        },
      ).get("codex-acp"),
    ).toBe("ready");
  });
});

function check(overrides: Partial<DoctorCheck> = {}): DoctorCheck {
  return {
    id: "ai-agent-claude",
    label: "Claude",
    status: "pass",
    message: "Installed",
    fixUrl: null,
    fixCommand: null,
    fixType: null,
    path: "C:/tools/claude.exe",
    bridgePath: null,
    rawOutput: null,
    authStatus: "authenticated",
    installedVersion: null,
    latestVersion: null,
    updateAvailable: null,
    installSource: null,
    selfUpdating: null,
    main: null,
    bridge: null,
    category: "agents",
    categoryLabel: "Agents",
    ...overrides,
  };
}

function report(checks: DoctorCheck[]): DoctorReport {
  return { checks } as DoctorReport;
}

describe("readinessFromReport auth handling", () => {
  it.each([
    [null, null, "fail", "not_installed"],
    ["C:/tools/kimi.cmd", "notAuthenticated", "warn", "not_ready"],
    ["C:/tools/kimi.cmd", "authenticated", "pass", "ready"],
  ] as const)("maps Kimi setup state %s / %s to %s", (path, authStatus, status, expected) => {
    const readiness = readinessFromReport(
      report([
        check({
          id: "ai-agent-kimi",
          label: "Kimi Code",
          path,
          authStatus,
          status,
        }),
      ]),
    );
    expect(readiness.get("kimi-acp")).toBe(expected);
  });

  it("keeps an agent usable when the auth probe could not run", () => {
    // The crate's `unknown`: a PATH-shadowed CLI is not signed out, so there is
    // no sign-in fix to offer and the agent stays usable.
    const readiness = readinessFromReport(
      report([check({ authStatus: "unknown" })]),
    );
    expect(readiness.get("claude-acp")).toBe("ready");
  });
});

function usage(
  overrides: Partial<ProviderRateLimits> = {},
): ProviderRateLimits {
  return {
    provider: "codex-acp",
    session: null,
    weekly: null,
    monthly: null,
    accountLabel: null,
    updatedAt: 1,
    error: null,
    status: "ok",
    configured: true,
    ...overrides,
  };
}

describe("applyUsageAuthReadiness", () => {
  it("drops the green tick for a doctor-ready agent whose usage says sign in", () => {
    const readiness = new Map<string, "ready" | "not_installed" | "not_ready">([
      ["codex-acp", "ready"],
      ["claude-acp", "ready"],
      ["grok-acp", "ready"],
    ]);
    const next = applyUsageAuthReadiness(readiness, [
      usage({
        status: "error",
        configured: false,
        error: "Codex usage request unauthorized (HTTP 401): token_revoked",
      }),
      usage({
        provider: "claude-acp",
        status: "ok",
        configured: true,
      }),
      usage({
        provider: "grok-acp",
        status: "ok",
        configured: true,
      }),
    ]);
    expect(next.get("codex-acp")).toBe("not_ready");
    expect(next.get("claude-acp")).toBe("ready");
    expect(next.get("grok-acp")).toBe("ready");
  });

  it("does not treat a configured refresh failure as signed out", () => {
    const readiness = new Map<string, "ready" | "not_installed" | "not_ready">([
      ["codex-acp", "ready"],
    ]);
    const next = applyUsageAuthReadiness(readiness, [
      usage({
        status: "error",
        configured: true,
        error: "Codex usage request failed (HTTP 500)",
      }),
    ]);
    expect(next.get("codex-acp")).toBe("ready");
  });
});
