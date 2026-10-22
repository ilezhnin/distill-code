import { describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import { providerModels } from "@/test/providerModels";
import {
  applyAccountReadiness,
  readinessFromReport,
  type AgentProviderReadiness,
} from "../useAgentProviderStatus";
import type {
  ProviderAccount,
  ProviderAccountModel,
  ProviderAccountStatus,
} from "../../api/providerAccounts";

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
function status(
  accountId: string,
  providerId: string,
  overrides: Partial<ProviderAccountStatus> = {},
): ProviderAccountStatus {
  return {
    accountId,
    providerId,
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
    ...overrides,
  };
}
function models(
  providerIds: string[],
  accounts: ProviderAccount[] = [],
): Record<string, ProviderAccountModel> {
  return Object.fromEntries(
    providerModels(providerIds, accounts).map((model) => [
      model.providerId,
      model,
    ]),
  );
}
const readiness = (
  entries: [string, AgentProviderReadiness][],
): Map<string, AgentProviderReadiness> => new Map(entries);

describe("account readiness for providers whose accounts Flock stores", () => {
  it("keeps an installed provider usable through a saved account when the system CLI is signed out", () => {
    const doctor = readiness([["codex-acp", "not_ready"]]);
    expect(
      applyAccountReadiness(doctor, models(["codex-acp"], [account]), {
        managed: status("managed", "codex-acp"),
      }).get("codex-acp"),
    ).toBe("ready");
    expect(doctor.get("codex-acp")).toBe("not_ready");
  });
  it("does not hide a missing bridge or invent readiness for revoked accounts", () => {
    expect(
      applyAccountReadiness(
        readiness([["codex-acp", "not_installed"]]),
        models(["codex-acp"], [account]),
        { managed: status("managed", "codex-acp") },
      ).get("codex-acp"),
    ).toBe("not_installed");
    expect(
      applyAccountReadiness(
        readiness([["codex-acp", "not_ready"]]),
        models(["codex-acp"], [account]),
        { managed: status("managed", "codex-acp", { state: "needs_auth" }) },
      ).get("codex-acp"),
    ).toBe("not_ready");
  });
  it("ignores external CLI sign-in when Flock has no connected account", () => {
    const doctor = readiness([["codex-acp", "ready"]]);
    expect(
      applyAccountReadiness(doctor, models(["codex-acp"]), {}).get("codex-acp"),
    ).toBe("not_ready");
    expect(
      applyAccountReadiness(doctor, models(["codex-acp"], [account]), {
        managed: status("managed", "codex-acp", { state: "needs_auth" }),
      }).get("codex-acp"),
    ).toBe("not_ready");
    expect(doctor.get("codex-acp")).toBe("ready");
  });
  it("keeps a saved account connected when its quota refresh is rate limited", () => {
    expect(
      applyAccountReadiness(
        readiness([["codex-acp", "ready"]]),
        models(["codex-acp"], [account]),
        {
          managed: status("managed", "codex-acp", {
            state: "error",
            stale: true,
            error: "HTTP 429",
          }),
        },
      ).get("codex-acp"),
    ).toBe("ready");
  });
});

describe("account readiness for a CLI sign-in", () => {
  const cli = models(["grok-acp", "kimi-acp", "copilot-acp", "amp-acp"]);
  it("drops the green tick for a doctor-ready harness whose usage says sign in", () => {
    const next = applyAccountReadiness(
      readiness([
        ["grok-acp", "ready"],
        ["kimi-acp", "ready"],
      ]),
      cli,
      {
        "cli-login-grok-acp": status("cli-login-grok-acp", "grok-acp", {
          state: "needs_auth",
          error: "Grok usage request unauthorized (HTTP 401): token_revoked",
        }),
        "cli-login-kimi-acp": status("cli-login-kimi-acp", "kimi-acp"),
      },
    );
    expect(next.get("grok-acp")).toBe("not_ready");
    expect(next.get("kimi-acp")).toBe("ready");
  });
  it("does not treat a configured refresh failure as signed out", () => {
    expect(
      applyAccountReadiness(readiness([["grok-acp", "ready"]]), cli, {
        "cli-login-grok-acp": status("cli-login-grok-acp", "grok-acp", {
          state: "error",
          stale: true,
          error: "Grok usage request failed (HTTP 500)",
        }),
      }).get("grok-acp"),
    ).toBe("ready");
  });
  it("lets the harness probe stand while no status adapter has reported a state", () => {
    const doctor = readiness([
      ["amp-acp", "ready"],
      ["copilot-acp", "not_ready"],
      ["kimi-acp", "not_ready"],
    ]);
    const next = applyAccountReadiness(doctor, cli, {
      "cli-login-amp-acp": status("cli-login-amp-acp", "amp-acp", {
        state: "unknown",
      }),
    });
    expect(next.get("amp-acp")).toBe("ready");
    expect(next.get("copilot-acp")).toBe("not_ready");
    expect(next.get("kimi-acp")).toBe("not_ready");
    expect(next).toBe(doctor);
  });
  it("trusts a live usage read over a stale harness probe", () => {
    expect(
      applyAccountReadiness(readiness([["kimi-acp", "not_ready"]]), cli, {
        "cli-login-kimi-acp": status("cli-login-kimi-acp", "kimi-acp", {
          state: "limited",
        }),
      }).get("kimi-acp"),
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
