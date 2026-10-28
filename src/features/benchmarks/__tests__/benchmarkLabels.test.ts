import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attentionLabel,
  accountDisplay,
  configurationOrigin,
  formatElapsed,
  formatSpend,
  modelDisplayName,
  providerVendor,
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

  it("names Z.ai models and their vendor like every other row", () => {
    const name = (modelName: string | null, modelId = "id") =>
      modelDisplayName({ providerId: "zai-acp", modelId, modelName });
    expect(name("Z.AI Coding Plan/GLM-5.3-Flash")).toBe("GLM 5.3 Flash");
    expect(name("Z.AI Coding Plan/GLM-5.3")).toBe("GLM 5.3");
    expect(name(null, "zai-coding-plan/glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(providerVendor("zai-acp")).toBe("Z.ai");
    expect(configurationOrigin({ providerId: "zai-acp" })).toBe(
      "Z.ai · zai-acp",
    );
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
      for (const count of [
        "scored",
        "total",
        "passed",
        "notPassed",
        "untested",
      ]) {
        expect(leaderboard.shares.coverage).toContain(`{{${count}}}`);
      }
      expect(leaderboard.shares.speedValue).toContain("{{value}}");
      expect(leaderboard.shares.costValue).toContain("{{value}}");
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

  it("reads a row's missing cost as unknown spend when some repetition was priced", () => {
    expect(formatSpend(t, null, 800, true)).toBe("Not reported");
    expect(formatSpend(t, null, 800, false)).toBe("No price");
  });
});

describe("attentionLabel", () => {
  const t = ((key: string, options?: { reason?: string }) =>
    ({
      "attention.restarted": "restarted",
      "attention.quota": "quota",
      "attention.quotaWait": "waiting for quota reset",
      "attention.credits": "credits",
      "attention.signIn": "sign in",
      "attention.signInWait": "wait for account update",
      "attention.signInDuration": "shorter time limit",
      "attention.failed": `failed: ${options?.reason}`,
      "attention.continuing": `continuing: ${options?.reason}`,
      "attention.unknown": "unknown",
      "attention.rateLimited": "provider request rate limit",
      "states.infrastructure_failure": "Infrastructure failure",
    })[key] ?? key) as Parameters<typeof attentionLabel>[0];

  it("names the cause and the one action that helps", () => {
    expect(
      attentionLabel(t, {
        state: "running",
        attention: {
          outcome: null,
          reason: JSON.stringify({
            data: { kind: "account_quota_wait", nextReset: 9_000_000_000_000 },
          }),
        },
      }),
    ).toBe("waiting for quota reset");
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
    // Credits benchmarks may not spend are named apart from a plain limit.
    expect(
      attentionLabel(t, {
        attention: {
          outcome: null,
          reason:
            'A test did not finish: the usage limit ran out and does not reset in time for the run to wait. {"code":-32010,"message":"Plan usage is spent, and benchmark credits are off: set a credit limit in Settings > Benchmarks"}',
        },
      }),
    ).toBe("credits");
    expect(
      attentionLabel(t, {
        attention: { outcome: null, reason: "Grok sign-in expired" },
      }),
    ).toBe("sign in");
    for (const reason of [
      "The Flock claude sign-in was not renewed (Account authorization is being changed; try again when it completes); the grant is kept. If it stays refused, sign in again in Settings > AI providers",
      "the account's sign-in is being updated; this test waits for the update to finish",
      "the Flock sign-in of this account renews once the tests running on it finish; this test starts then",
    ]) {
      expect(
        attentionLabel(t, {
          attention: { outcome: "capability_missing", reason },
        }),
      ).toBe("wait for account update");
    }
    expect(
      attentionLabel(t, {
        attention: {
          outcome: "capability_missing",
          reason:
            "This test may run longer than a claude sign-in lasts; choose a shorter time limit",
        },
      }),
    ).toBe("shorter time limit");
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

  it("keeps active attempt failures visible without asking to resume a running run", () => {
    const attention = {
      outcome: "resource_busy",
      reason: "Invented memory reservation refused",
    };
    expect(attentionLabel(t, { state: "running", attention })).toBe(
      `continuing: ${attention.reason}`,
    );
    expect(attentionLabel(t, { state: "needs_attention", attention })).toBe(
      `failed: ${attention.reason}`,
    );
    expect(
      attentionLabel(t, {
        state: "running",
        attention: {
          outcome: "infrastructure_failure",
          reason: '{"code":-32010}',
        },
      }),
    ).toBe("continuing: Infrastructure failure");
    expect(
      attentionLabel(t, {
        state: "running",
        attention: {
          outcome: "pending_review",
          reason:
            "No judge panel: 1 eligible judge(s), at least 2 are required",
        },
      }),
    ).toBe("continuing: runIssues.noPanel");
  });

  it.each([
    "running",
    "needs_attention",
  ])("names accepted provider rate limits in a %s run without exposing payloads", (state) => {
    const reason = JSON.stringify({
      code: -32603,
      message: "Internal error: Rate limit reached for requests",
      data: {
        accountId: "private-account",
        dispatchStarted: true,
        promptNotAccepted: false,
        errorName: "APIError",
        service: "session",
      },
      nativeExecutionMs: 1200,
    });
    expect(
      attentionLabel(t, {
        state,
        attention: { outcome: "infrastructure_failure", reason },
      }),
    ).toBe(
      `${state === "running" ? "continuing" : "failed"}: provider request rate limit`,
    );
  });

  it.each([
    "Rate limit reached for requests",
    "rate_limit_error",
    "Too many requests",
    "HTTP 429",
    '  {"message":"status: 429"}',
  ])("recognizes rate limits from the provider message: %s", (reason) => {
    expect(
      attentionLabel(t, {
        state: "running",
        attention: { outcome: "infrastructure_failure", reason },
      }),
    ).toBe("continuing: provider request rate limit");
  });

  it.each([
    '{"message":"Request failed","data":{"accountId":"rate limit"}}',
    '{"message":"Request failed","nativeExecutionMs":429810}',
    '{"message":"HTTP 4290"}',
    '{"message":{"nested":"rate limit"}}',
    '{"message":"rate limit"',
  ])("keeps unknown diagnostics private without false rate limits: %s", (reason) => {
    expect(
      attentionLabel(t, {
        state: "running",
        attention: { outcome: "infrastructure_failure", reason },
      }),
    ).toBe("continuing: Infrastructure failure");
  });
});
