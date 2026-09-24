import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_ENTRY_LENGTH,
  MAX_REPORT_LIST_ENTRIES,
  parseStructuredReport,
  unrecognizedReportStatusRisk,
} from "./orchestratorReport";

function blockedFence(body: string): string {
  return `\`\`\`distill-report\n${body}\n\`\`\``;
}

describe("orchestratorReport", () => {
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
});

describe("a report's size", () => {
  it("caps how many decisions, risks and artifacts it carries, and how long each is", () => {
    const report = parseStructuredReport(
      "run-1",
      "completed",
      blockedFence(
        JSON.stringify({
          status: "completed",
          summary: "Did it",
          decisions: Array.from(
            { length: MAX_REPORT_LIST_ENTRIES + 10 },
            (_, index) => `decision ${index}`,
          ),
          risks: ["r".repeat(5_000)],
          artifacts: Array.from(
            { length: MAX_REPORT_LIST_ENTRIES + 10 },
            (_, index) => ({
              label: `file-${index}.ts`,
              path: "p".repeat(900),
            }),
          ),
        }),
      ),
    );
    // One extra line says what was dropped, so nothing reads as complete.
    expect(report.decisions).toHaveLength(MAX_REPORT_LIST_ENTRIES + 1);
    expect(report.decisions.at(-1)).toContain("10 more");
    expect(report.artifacts).toHaveLength(MAX_REPORT_LIST_ENTRIES);
    expect(report.artifacts[0].path?.length).toBeLessThan(
      MAX_REPORT_ENTRY_LENGTH + 100,
    );
    expect(report.risks[0].length).toBeLessThan(MAX_REPORT_ENTRY_LENGTH + 100);
    expect(report.risks[0]).toContain("truncated");
  });
});

describe("the blocked report contract (prompt and parser together)", () => {
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
});
