import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { draft, run } from "./fixtures";

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
