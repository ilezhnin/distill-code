import { describe, expect, it } from "vitest";
import {
  parseStructuredReport,
  stripReportFence,
  wrapOrchestratorTaskPrompt,
} from "./orchestratorReport";

describe("orchestratorReport", () => {
  it("asks the orchestrator for a distill-report block", () => {
    expect(wrapOrchestratorTaskPrompt("Fix login")).toContain(
      "```distill-report",
    );
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

  it("strips the report fence from leftover prose", () => {
    expect(stripReportFence("Hello\n```distill-report\n{}\n```")).toBe("Hello");
  });
});
