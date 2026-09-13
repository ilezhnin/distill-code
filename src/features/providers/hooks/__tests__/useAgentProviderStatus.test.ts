import { describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import { readinessFromReport } from "../useAgentProviderStatus";

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
});
