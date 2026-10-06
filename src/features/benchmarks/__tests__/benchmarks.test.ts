import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { attempt, attemptSummary, definition, draft, run } from "./fixtures";
import type { DesignEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("benchmark transport and navigation contracts", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useBenchmarkViewStore.setState({ dirty: false, pending: null });
  });
  it("preserves revision checks and stable dispatch keys on IPC", async () => {
    await benchmarkApi.saveDraft(null, null, draft);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_save_draft", {
      id: null,
      expectedRevision: null,
      draft,
    });
    await benchmarkApi.saveDraft("test", 7, draft);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_save_draft", {
      id: "test",
      expectedRevision: 7,
      draft,
    });
    await benchmarkApi.previewRun(run.request);
    await benchmarkApi.startRun(run.request);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_start_run", {
      request: run.request,
    });
    await benchmarkApi.startRun(run.request, "previous-sitting");
    expect(invoke).toHaveBeenLastCalledWith("benchmark_start_run", {
      request: run.request,
      replaceRunId: "previous-sitting",
    });
  });
  it("preserves structured denials and never turns them into empty success", async () => {
    const rejection = {
      code: "revision_conflict",
      message: "Draft changed elsewhere",
    };
    vi.mocked(invoke).mockRejectedValue(rejection);
    await expect(benchmarkApi.saveDraft("test", 1, draft)).rejects.toBe(
      rejection,
    );
    expect(benchmarkErrorMessage(rejection)).toBe("Draft changed elsewhere");
  });
  it("keeps training export held-out outcomes opt-in", async () => {
    await benchmarkApi.exportDataset(false);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_export_dataset", {
      includeHeldOut: false,
    });
  });
  it("only returns complete design measurements, including failures", async () => {
    const card = {
      attemptId: attempt.id,
      runId: run.id,
      versionId: attempt.versionId,
      configuration: attempt.configuration,
      phase: "terminal",
      score: 0,
      requiredRepetitions: 3,
      completedRepetitions: 3,
    } as DesignEntry;
    vi.mocked(invoke).mockResolvedValueOnce([
      card,
      { ...card, attemptId: "partial", completedRepetitions: 2 },
      { ...card, attemptId: "retired", outcome: "superseded", score: null },
      { ...card, attemptId: "pending", phase: "awaiting_judges", score: null },
    ]);
    expect(await benchmarkApi.listDesigns({})).toEqual([card]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    2, 3,
  ])("checks %i scored repetitions while an older backend finishes its active run", async (scored) => {
    const card = {
      attemptId: attempt.id,
      runId: run.id,
      versionId: attempt.versionId,
      configuration: attempt.configuration,
      phase: "terminal",
      score: 0,
    } as DesignEntry;
    const attempts = [0, 1, 2].map((repetition) => ({
      ...attempt,
      id: `a-${repetition}`,
      repetition,
    }));
    vi.mocked(invoke)
      .mockResolvedValueOnce([card])
      .mockResolvedValueOnce([definition])
      .mockResolvedValueOnce({ ...run, attempts })
      .mockResolvedValueOnce(
        attempts.map((a, index) => ({
          ...attemptSummary,
          id: a.id,
          repetition: a.repetition,
          score: index < scored ? 0 : null,
        })),
      );
    const entries = await benchmarkApi.listDesigns({});
    expect(entries).toHaveLength(scored === 3 ? 1 : 0);
    expect(invoke).toHaveBeenLastCalledWith("benchmark_list_attempts", {
      query: {
        runId: run.id,
        attemptIds: ["a-0", "a-1", "a-2"],
        limit: 100,
        asOf: undefined,
      },
    });
  });
  it("blocks navigation with unsaved changes and cancels superseded requests", () => {
    const first = vi.fn(),
      second = vi.fn(),
      cancelFirst = vi.fn();
    useBenchmarkViewStore.getState().setDirty(true);
    useBenchmarkViewStore.getState().guardNavigation(first, cancelFirst);
    useBenchmarkViewStore.getState().guardNavigation(second);
    expect(first).not.toHaveBeenCalled();
    expect(cancelFirst).toHaveBeenCalledOnce();
    useBenchmarkViewStore.getState().resolveNavigation(false);
    expect(second).not.toHaveBeenCalled();
    expect(useBenchmarkViewStore.getState().dirty).toBe(true);
    useBenchmarkViewStore.getState().guardNavigation(second);
    useBenchmarkViewStore.getState().resolveNavigation(true);
    expect(second).toHaveBeenCalledOnce();
    expect(useBenchmarkViewStore.getState().dirty).toBe(false);
  });
});
