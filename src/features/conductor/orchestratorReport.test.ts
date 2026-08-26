import { describe, expect, it } from "vitest";
import {
  MAX_BLOCKED_REASON_LENGTH,
  MISSING_BLOCKED_REASON,
  parseStructuredReport,
  stripReportFence,
  unrecognizedReportStatusRisk,
  wrapOrchestratorTaskPrompt,
} from "./orchestratorReport";

function blockedFence(body: string): string {
  return `\`\`\`distill-report\n${body}\n\`\`\``;
}

describe("orchestratorReport", () => {
  it("asks the orchestrator for a distill-report block", () => {
    expect(wrapOrchestratorTaskPrompt("Fix login")).toContain(
      "```distill-report",
    );
  });

  it("explains the artifacts field and its object shape", () => {
    const prompt = wrapOrchestratorTaskPrompt("Fix login");
    // The parser drops bare strings (label is required), so the wrapper must
    // teach the object form — otherwise E2 starves on well-meant reports.
    expect(prompt).toContain('{"label": "x.md", "path": "src/x.md"}');
    expect(prompt).toContain("created, changed, ran, or inspected");
    expect(prompt).toContain("Bare strings are dropped");
  });

  it("keeps the report block out of created files", () => {
    // Seen live (T2, 2026-08-24): a writer pasted its distill-report JSON into
    // poem.md, poisoning the artifact and the verifier's quote of it.
    const prompt = wrapOrchestratorTaskPrompt("Fix login");
    expect(prompt).toContain("belongs in your reply and nowhere else");
    expect(prompt).toContain("never write it");
  });

  it("parses a fenced structured report", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      `Done.\n\n\`\`\`distill-report
{"status":"completed","summary":"Login is fixed","decisions":["Kept the queue"],"artifacts":[{"label":"login.ts","path":"src/login.ts"}],"risks":["No e2e"],"needsOperator":false,"nextSuggestedTask":null}
\`\`\``,
    );

    expect(report.summary).toBe("Login is fixed");
    expect(report.decisions).toEqual(["Kept the queue"]);
    expect(report.artifacts).toEqual([
      { label: "login.ts", path: "src/login.ts" },
    ]);
    expect(report.risks).toEqual(["No e2e"]);
  });

  it("never leaves a fence-only reply with an empty summary", () => {
    // Stripping the fence off a reply that was nothing but the fence used to
    // leave "", which every consumer reads as "no report yet" — the graph sync
    // then re-attached it on every pass until the renderer crashed.
    const report = parseStructuredReport(
      "run-1",
      "completed",
      '```distill-report\n{"status":"completed","decisions":[],"artifacts":[]}\n```',
    );

    expect(report.summary).not.toBe("");
    expect(report.status).toBe("completed");
  });

  it("strips the report fence from leftover prose", () => {
    expect(stripReportFence("Hello\n```distill-report\n{}\n```")).toBe("Hello");
  });
});

describe("the blocked report contract (prompt and parser together)", () => {
  it("teaches blocked with a reason, as distinct from failed", () => {
    // Prompt/parser pair: the words the wrapper teaches are exactly the
    // fields the parser reads. If either side changes, both tests break.
    const prompt = wrapOrchestratorTaskPrompt("Fix login");
    expect(prompt).toContain('"status": "failed"');
    expect(prompt).toContain('"status": "blocked"');
    expect(prompt).toContain('"reason" field');
    expect(prompt).toContain("Never invent a result");
  });

  it("parses a blocked report with its reason and forces needsOperator", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence(
        '{"status":"blocked","reason":"src/net/retry.ts does not exist","summary":"Could not start","decisions":[],"artifacts":[],"risks":[],"needsOperator":false,"nextSuggestedTask":null}',
      ),
    );

    expect(report.status).toBe("blocked");
    expect(report.reason).toBe("src/net/retry.ts does not exist");
    // Blocked is by definition the operator's to unblock, whatever the
    // worker set the flag to.
    expect(report.needsOperator).toBe(true);
  });

  it("reads a report without a status field by the run's own outcome", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence('{"summary":"All done","decisions":[],"artifacts":[]}'),
    );
    expect(report.status).toBe("completed");
    expect(report.reason).toBeUndefined();
    expect(report.risks).toEqual([]);
  });

  it("keeps a reasonless blocked report blocked, with a stand-in reason", () => {
    // Downgrading blocked to done over a missing field would be the exact
    // fabrication the status exists to prevent.
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence('{"status":"blocked","summary":"Stuck"}'),
    );
    expect(report.status).toBe("blocked");
    expect(report.reason).toBe(MISSING_BLOCKED_REASON);
  });

  it("announces an unrecognized status as a risk instead of a silent done", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence('{"status":"blockd","summary":"Stuck","risks":["flaky"]}'),
    );
    // The safe fallback for the *status* is the run's own outcome…
    expect(report.status).toBe("completed");
    // …and the miss is visible everywhere the report is read.
    expect(report.risks).toEqual([
      "flaky",
      unrecognizedReportStatusRisk("blockd"),
    ]);
  });

  it("truncates a runaway reason at the cap", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence(
        `{"status":"blocked","reason":"${"x".repeat(MAX_BLOCKED_REASON_LENGTH + 50)}","summary":"Stuck"}`,
      ),
    );
    expect(report.reason).toHaveLength(MAX_BLOCKED_REASON_LENGTH);
    expect(report.reason?.endsWith("…")).toBe(true);
  });

  it("drops a reason that rides on a non-blocked report", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence('{"status":"completed","reason":"noise","summary":"Done"}'),
    );
    expect(report.reason).toBeUndefined();
  });
});
