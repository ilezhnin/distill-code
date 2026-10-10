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
  it("preserves the native budget scope when previewing a saved task", async () => {
    const request = {
      task: publicSelectorTask({
        ...draft,
        environment: {
          nativeBudgetRecipe: "native-root-wall-budget-v1",
          nativeRootBudget: { rootId: "SECRET-LEASE" },
        },
      }),
      targetFamily: "new-family",
      targetGroup: "new-group",
      candidates: [],
      hardCandidateKey: null,
      minQuality: 0.5,
    };
    await benchmarkApi.predictSelector("saved-fit", request);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_predict_selector", {
      id: "saved-fit",
      request: expect.objectContaining({
        task: expect.objectContaining({
          budgetRecipe: "native-root-wall-budget-v1",
        }),
      }),
    });
    expect(JSON.stringify(request.task)).not.toContain("SECRET");
  });
  it("includes the public cumulative patch without repository paths or lineage", () => {
    const before = {
      recipe: "repository-cumulative-v1",
      rootTree: "a".repeat(40),
      beforeTree: "a".repeat(40),
      afterTree: "b".repeat(40),
      patch: "diff --git a/example.txt b/example.txt\n+public change\n",
      patchHash: "c".repeat(64),
      archiveHash: "d".repeat(64),
    };
    const task = publicSelectorTask({
      ...draft,
      environment: {
        repository: { path: "SECRET-PATH" },
        repositoryArtifactInput: {
          before,
          lineage: [{ private: "SECRET-LINEAGE" }],
          evaluation: "SECRET-ANSWER",
        },
      },
    });
    expect(task.repositoryRecipe).toBe("repository-cumulative-v1");
    expect(task.repositoryArtifact).toEqual(before);
    expect(JSON.stringify(task)).not.toContain("SECRET");
    expect(
      publicSelectorTask({
        ...draft,
        environment: {
          repositoryArtifactInput: {
            before: { ...before, unexpected: "SECRET-EXTRA" },
          },
        },
      }).repositoryArtifact,
    ).toBeUndefined();
  });
  it("keeps legacy tasks unchanged when optional context is absent or invalid", () => {
    for (const environment of [
      null,
      [],
      { nativeBudgetRecipe: 10, repositoryArtifactInput: { before: null } },
    ]) {
      const task = publicSelectorTask({ ...draft, environment });
      expect(task.budgetRecipe).toBeUndefined();
      expect(task.repositoryRecipe).toBeUndefined();
      expect(task.repositoryArtifact).toBeUndefined();
    }
  });
});
