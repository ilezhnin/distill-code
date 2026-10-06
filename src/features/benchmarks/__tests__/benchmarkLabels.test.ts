import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attentionLabel,
  accountDisplay,
  formatElapsed,
  formatSpend,
  modelDisplayName,
  stateLabel,
  stateTone,
} from "../lib/benchmarkLabels";

interface BenchmarkStrings {
  states: Record<string, string>;
  run: Record<string, string>;
  leaderboard: {
    boards: Record<string, string>;
    boardDescriptions: Record<string, string>;
    shares: Record<string, string>;
  };
}

const strings = (locale: string) =>
  JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        `src/shared/i18n/locales/${locale}/benchmarks.json`,
      ),
      "utf8",
    ),
  ) as BenchmarkStrings;

describe("benchmark copy", () => {
  it("translates every verdict a judge evaluation records", () => {
    const en = strings("en").states;
    const es = strings("es").states;
    for (const verdict of ["judged", "abstained", "rendered"]) {
      expect(en[verdict]).toBeTruthy();
      expect(es[verdict]).toBeTruthy();
      expect(es[verdict]).not.toBe(en[verdict]);
    }
  });

  it("names a policy violation as its own negative outcome", () => {
    expect(stateTone("execution_violation")).toBe("negative");
    expect(strings("en").states.execution_violation).toBe("Policy violation");
    expect(strings("es").states.execution_violation).toBe(
      "Infracción de la política",
    );
    const t = ((key: string) =>
      key === "states.execution_violation"
        ? "Policy violation"
        : key) as Parameters<typeof stateLabel>[0];
    expect(stateLabel(t, "execution_violation")).toBe("Policy violation");
  });

  it("shows the CLI sign-in identity by name, never by its id", () => {
    expect(strings("en").run.cliLogin).toBe("CLI sign-in");
    expect(strings("es").run.cliLogin).toBe("Sesión de la CLI");
    const t = ((key: string) =>
      ({ "run.cliLogin": "CLI sign-in", "run.noAccount": "No account" })[key] ??
      key) as Parameters<typeof accountDisplay>[0];
    expect(accountDisplay(t, "cli-login-grok-acp")).toBe("CLI sign-in");
    expect(accountDisplay(t, null)).toBe("No account");
    expect(accountDisplay(t, "account-1")).toBe("account-1");
  });

  it("puts the vendor in front of the names Claude Code and Kimi Code list", () => {
    const name = (providerId: string, modelName: string) =>
      modelDisplayName({ providerId, modelId: "id", modelName });
    expect(name("kimi-acp", "K3")).toBe("Kimi K3");
    expect(name("kimi-acp", "K2.8 Preview")).toBe("Kimi K2.8 Preview");
    expect(name("kimi-acp", "Kimi K3")).toBe("Kimi K3");
    expect(name("claude-acp", "Opus 5.5")).toBe("Claude Opus 5.5");
    expect(name("codex-acp", "GPT-6-Astra")).toBe("GPT-6-Astra");
    expect(name("grok-acp", "Grok 4.7")).toBe("Grok 4.7");
  });

  it("names only the overall board and describes a class board by its rule", () => {
    for (const locale of ["en", "es"] as const) {
      const leaderboard = strings(locale).leaderboard;
      expect(Object.keys(leaderboard.boards)).toEqual(["overall"]);
      expect(Object.keys(leaderboard.boardDescriptions)).toEqual([
        "overall",
        "class",
      ]);
      expect(leaderboard.boardDescriptions.class).toContain("{{label}}");
      expect(Object.keys(leaderboard.shares)).toEqual([
        "reliability",
        "speed",
        "cost",
      ]);
    }
  });
});

describe("formatElapsed", () => {
  const t = ((key: string, options?: { count?: number }) =>
    ({
      "elapsed.seconds": `${options?.count} s`,
      "elapsed.minutes": `${options?.count} min`,
      "elapsed.hours": `${options?.count} h`,
      "elapsed.days": `${options?.count} days`,
      unknown: "Not reported",
    })[key] ?? key) as Parameters<typeof formatElapsed>[0];

  it("reads in the largest unit that still carries the remainder", () => {
    expect(formatElapsed(t, null)).toBe("Not reported");
    expect(formatElapsed(t, 42_400)).toBe("42 s");
    expect(formatElapsed(t, 155_000)).toBe("2 min 35 s");
    expect(formatElapsed(t, 180_000)).toBe("3 min");
    expect(formatElapsed(t, 4_320_000)).toBe("1 h 12 min");
    expect(formatElapsed(t, 183_600_000)).toBe("2 days 3 h");
  });
});

describe("formatSpend", () => {
  const t = ((key: string) =>
    ({ unknown: "Not reported", noPrice: "No price" })[key] ??
    key) as Parameters<typeof formatSpend>[0];

  it("names a missing price apart from a provider that reported nothing", () => {
    expect(formatSpend(t, 0.0125, 800)).toBe("$0.0125");
    // Tokens were counted, so only a price is missing.
    expect(formatSpend(t, null, 800)).toBe("No price");
    // A refused or failed call counted nothing.
    expect(formatSpend(t, null, null)).toBe("Not reported");
  });
});

describe("attentionLabel", () => {
  const t = ((key: string, options?: { reason?: string }) =>
    ({
      "attention.restarted": "restarted",
      "attention.quota": "quota",
      "attention.signIn": "sign in",
      "attention.failed": `failed: ${options?.reason}`,
      "attention.unknown": "unknown",
      "states.infrastructure_failure": "Infrastructure failure",
    })[key] ?? key) as Parameters<typeof attentionLabel>[0];

  it("names the cause and the one action that helps", () => {
    expect(
      attentionLabel(t, {
        attention: {
          outcome: "dispatch_uncertain",
          reason: "Remote acceptance cannot be established after restart",
        },
      }),
    ).toBe("restarted");
    expect(
      attentionLabel(t, {
        attention: {
          outcome: null,
          reason: "A test did not finish: the usage limit ran out",
        },
      }),
    ).toBe("quota");
    expect(
      attentionLabel(t, {
        attention: { outcome: null, reason: "Grok sign-in expired" },
      }),
    ).toBe("sign in");
    // A bridge's raw JSON reads by its kind, a sentence by itself.
    expect(
      attentionLabel(t, {
        attention: {
          outcome: "infrastructure_failure",
          reason: '{"code":-32010}',
        },
      }),
    ).toBe("failed: Infrastructure failure");
    expect(
      attentionLabel(t, {
        attention: {
          outcome: "infrastructure_failure",
          reason: "Bridge exited with code 3",
        },
      }),
    ).toBe("failed: Bridge exited with code 3");
    expect(attentionLabel(t, { attention: null })).toBe("unknown");
  });
});
