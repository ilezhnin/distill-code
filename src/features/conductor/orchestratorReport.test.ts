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
