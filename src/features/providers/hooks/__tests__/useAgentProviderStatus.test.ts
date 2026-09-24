import { describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import type { ProviderRateLimits } from "@/features/status/lib/rateLimitTypes";
import {
  applyUsageAuthReadiness,
  readinessFromReport,
} from "../useAgentProviderStatus";

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

  it("blocks an agent the probe reported as signed out", () => {
    const readiness = readinessFromReport(
      report([check({ authStatus: "notAuthenticated" })]),
    );
    expect(readiness.get("claude-acp")).toBe("not_ready");
  });

  it("keeps an agent usable when the auth probe could not run", () => {
    // The crate's `unknown`: a PATH-shadowed CLI is not signed out, so there is
    // no sign-in fix to offer and the agent stays usable.
    const readiness = readinessFromReport(
      report([check({ authStatus: "unknown" })]),
    );
    expect(readiness.get("claude-acp")).toBe("ready");
  });

  it("asks a signed-out Grok to sign in", () => {
    const readiness = readinessFromReport(
      report([
        check({
          id: "ai-agent-grok",
          label: "Grok",
          status: "warn",
          path: "C:/Users/dev/.grok/bin/grok.exe",
          authStatus: "notAuthenticated",
          fixType: "auth",
          fixCommand: "grok login --oauth",
        }),
      ]),
    );
    expect(readiness.get("grok-acp")).toBe("not_ready");
  });

  it("marks a signed-in Grok ready", () => {
    const readiness = readinessFromReport(
      report([
        check({
          id: "ai-agent-grok",
          label: "Grok",
          path: "C:/Users/dev/.grok/bin/grok.exe",
          authStatus: "authenticated",
        }),
      ]),
    );
    expect(readiness.get("grok-acp")).toBe("ready");
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
