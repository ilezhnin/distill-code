import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { benchmarkApi } from "../api/benchmarks";
import {
  publicSelectorTask,
  selectorTaskGroup,
} from "../lib/benchmarkLearning";
import { draft, run } from "./fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("learned selector boundary", () => {
  it("projects public context without evaluators, source or execution lineage", () => {
    const input = {
      ...draft,
      evaluator: { ...draft.evaluator, expected: "SECRET-ANSWER" },
      source: "SECRET-SOURCE",
      environment: { hidden: "SECRET-CHECK", splitGroup: "related" },
      entryState: {
        schemaVersion: 1,
        rootTaskId: "SECRET-ROOT",
        stepId: "SECRET-STEP",
        parentStepId: null,
        fixtureSnapshotHash: "SECRET-HASH",
        contentHash: "SECRET-CONTENT",
        conversationPrefix: "visible history",
        previousReports: ["visible report"],
        remainingBudgetSeconds: 90,
      },
    };
    const task = publicSelectorTask(input);
    expect(JSON.stringify(task)).not.toContain("SECRET");
    expect(task.entry).toEqual({
      conversationPrefix: "visible history",
      previousReports: ["visible report"],
      remainingBudgetSeconds: 90,
    });
    expect(selectorTaskGroup(input)).toBe("related");
    expect(selectorTaskGroup({ ...input, environment: {} })).toBe(
      input.taskFamily,
    );
  });
  it("keeps fitting and prediction separate and passes explicit availability", async () => {
    const request = {
      task: publicSelectorTask(draft),
      targetFamily: "new",
      targetGroup: "new",
      candidates: run.request.configurations.map((configuration) => ({
        configuration,
        available: false,
        reason: null,
      })),
      hardCandidateKey: null,
      minQuality: 0.5,
    };
    await benchmarkApi.predictSelector("saved-fit", request);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_predict_selector", {
      id: "saved-fit",
      request,
    });
    expect(Object.keys(request)).not.toContain("snapshot");
  });
});
