import { describe, expect, it } from "vitest";
import {
  judgingFailureLabel,
  runJudgingIssues,
} from "../lib/benchmarkRunIssues";
import type { Attempt, Evaluation } from "../types";

describe("judging failure causes", () => {
  it("shows the current unresolved failure instead of a corrected old abstention", () => {
    const evaluation = (
      id: string,
      at: number,
      provenance: string,
      score: number | null,
      reason: string,
    ): Evaluation => ({
      id,
      evaluatorRevision: "1",
      verdict: score == null ? "abstained" : "judged",
      artifacts: [],
      createdAt: at,
      provenance,
      score,
      reason,
      judge: {
        id,
        providerId: "invented",
        accountId: null,
        modelId: id,
        effort: null,
        fastMode: null,
        billingMode: "subscription",
        executionProfile: "native_text",
        inventoryRevision: "invented",
      },
      details: { judgeBatchId: "batch" },
    });
    const attempt = {
      id: "attempt",
      phase: "terminal",
      outcome: "pending_review",
      reason: "Panel incomplete",
      evaluations: [
        evaluation(
          "first",
          1,
          "judge_failure",
          null,
          "Critical checks unresolved",
        ),
        evaluation(
          "second",
          2,
          "judge_failure",
          null,
          "Judge returned no valid score sheet: invalid evidence",
        ),
        evaluation("first", 3, "judge", 0, "Corrected assessment"),
      ],
    } as Attempt;
    expect(runJudgingIssues([attempt], new Map())).toEqual([
      {
        reason: "Judge returned no valid score sheet: invalid evidence",
        count: 1,
      },
    ]);
    expect(runJudgingIssues([attempt], new Map([["attempt", 0]]))).toEqual([]);
  });

  it("retains the sheet rejection detail in the visible label", () => {
    const t = () => "A judge returned an invalid score sheet.";
    expect(
      judgingFailureLabel(
        t,
        "Judge returned no valid score sheet: more than four quotes",
      ),
    ).toBe("A judge returned an invalid score sheet. more than four quotes");
    expect(judgingFailureLabel(t, "Judge returned no valid score sheet")).toBe(
      "A judge returned an invalid score sheet.",
    );
  });
});
