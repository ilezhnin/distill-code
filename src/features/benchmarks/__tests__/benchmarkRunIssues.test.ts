import { describe, expect, it } from "vitest";
import {
  judgePanelEvidenceLabel,
  judgingFailureLabel,
  runJudgingIssues,
} from "../lib/benchmarkRunIssues";
import type { Attempt, Evaluation } from "../types";

describe("judging failure causes", () => {
  const noPanel =
    "No judge panel: 1 eligible judge(s), at least 2 are required";
  const t = (key: string, options?: Record<string, unknown>) =>
    options
      ? `${key}:${options.provider ?? `${options.available}/${options.required}`}`
      : key;

  it("localizes bounded discovery causes beside the original panel count", () => {
    const reason = `${noPanel}. Judge availability: Claude: local text policy verification required; Codex: benchmark runtime unavailable; Z.ai: model inventory unavailable.`;
    expect(judgingFailureLabel(t, reason)).toBe(
      "runIssues.noPanel:1/2 runIssues.discoveryPolicy:Claude runIssues.discoveryRuntime:Codex runIssues.discoveryInventory:Z.ai",
    );
    expect(judgingFailureLabel(t, reason, true)).toBe(
      "runIssues.noPanelRecorded:1/2 runIssues.discoveryPolicyRecorded:Claude runIssues.discoveryRuntimeRecorded:Codex runIssues.discoveryInventoryRecorded:Z.ai",
    );
    expect(judgingFailureLabel(t, noPanel)).toBe("runIssues.noPanel:1/2");
    expect(
      judgingFailureLabel(
        t,
        `${noPanel}. A judge rejected this request; recovery needs another calibrated judge from the pool. Judge availability: Claude: local text policy verification required.`,
      ),
    ).toBe(
      "runIssues.noPanel:1/2 runIssues.discoveryRecovery runIssues.discoveryPolicy:Claude",
    );
  });

  it("keeps evidence details intact unless the full owned grammar matches", () => {
    expect(judgePanelEvidenceLabel(t, noPanel)).toBe("runIssues.noPanel:1/2");
    const current = `${noPanel}. Judge availability: Claude: local text policy verification required.`;
    expect(judgePanelEvidenceLabel(t, current)).toBe(
      "runIssues.noPanel:1/2 runIssues.discoveryPolicy:Claude",
    );
    for (const reason of [
      `${noPanel}. A judge rejected this request; recovery needs another calibrated judge from the pool`,
      `${noPanel}. Invented historical explanation`,
      `${noPanel}. Judge availability: unknown historical format`,
      "Frozen judge settings changed: invented runtime detail",
      "Critical checks unresolved: invented missing evidence",
    ])
      expect(judgePanelEvidenceLabel(t, reason)).toBe(reason);
  });

  it("never echoes malformed discovery tails or arbitrary provider text", () => {
    for (const suffix of [
      ". Judge availability: Claude: Bearer invented-secret.",
      ". Judge availability: Unknown: local text policy verification required.",
      ". Judge availability: Claude: local text policy verification required; Codex: model inventory unavailable; account=invented-secret.",
      ". Judge availability: Claude: local text policy verification required; Claude: model inventory unavailable.",
      ". Judge availability: Claude: local text policy verification required\n; Codex: model inventory unavailable.",
      ". Judge availability: Claude: local text policy verification required.\nC:\\invented\\credentials",
      ". Judge availability: Claude: local text policy verification required",
      `. Judge availability: ${"private".repeat(200)}.`,
      ". A judge rejected arbitrary provider output. Judge availability: Claude: local text policy verification required.",
    ]) {
      expect(judgingFailureLabel(t, noPanel + suffix)).toBe(
        "runIssues.noPanel:1/2",
      );
    }
    expect(
      judgingFailureLabel(
        t,
        `provider output: ${noPanel}. Judge availability: Claude: local text policy verification required.`,
      ),
    ).toBe("runIssues.noPanel:1/2");
  });

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
