import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { benchmarkApi } from "../api/benchmarks";
import {
  COALESCED_REFRESH_MS,
  THROTTLED_REFRESH_MS,
  USAGE_LEDGER_REFRESH_MS,
  useBenchmarkRuntime,
  useFreshBenchmarkUsage,
} from "../hooks/useBenchmarks";
import { projectBenchmarkUsageBatch } from "@/features/stats/lib/usageLedger";
import type { BenchmarkChange, UsageLedgerEntry } from "../types";
import { runSummary } from "./fixtures";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("../api/benchmarks", () => ({
  benchmarkApi: {
    getUsageLedger: vi.fn(),
    listRuns: vi.fn(),
    eventsSince: vi.fn(),
    listen: vi.fn(),
  },
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  projectBenchmarkUsageBatch: vi.fn(),
}));
vi.mock("@/shared/api/flockStore", () => ({
  isDesktopRuntime: () => true,
}));

const entry: UsageLedgerEntry = {
  attemptId: "attempt-1",
  sessionId: "owned-session-1",
  providerId: "claude-acp",
  modelId: "native-model",
  effort: null,
  inputTokens: null,
  outputTokens: 12,
  costUsd: null,
  durationMs: 300,
  finishedAt: 1_000,
};

function Shell() {
  useBenchmarkRuntime();
  return <div>Chat</div>;
}

describe("persistent benchmark runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.eventsSince).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listen).mockResolvedValue(() => {});
  });
  afterEach(cleanup);

  it("restores sealed usage and follows completion while another view is open", async () => {
    let changed: ((change: BenchmarkChange) => void) | undefined;
    const stop = vi.fn();
    vi.mocked(benchmarkApi.listen).mockImplementation(async (callback) => {
      changed = callback;
      return stop;
    });
    const second = {
      ...entry,
      attemptId: "attempt-2",
      sessionId: "owned-session-2",
    };
    vi.mocked(benchmarkApi.getUsageLedger)
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([entry, second]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The ledger's own interval starts with the query, under these timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(
        <QueryClientProvider client={client}>
          <Shell />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(projectBenchmarkUsageBatch).toHaveBeenCalledOnce(),
      );
      expect(projectBenchmarkUsageBatch).toHaveBeenCalledWith([entry]);
      // The usage ledger reads every attempt, so events never refresh it;
      // it follows on its own interval.
      act(() => changed?.({ sequence: 1 }));
      await act(() => vi.advanceTimersByTimeAsync(THROTTLED_REFRESH_MS));
      expect(benchmarkApi.getUsageLedger).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(USAGE_LEDGER_REFRESH_MS));
      await waitFor(() =>
        expect(projectBenchmarkUsageBatch).toHaveBeenCalledTimes(2),
      );
    } finally {
      vi.useRealTimers();
    }
    expect(projectBenchmarkUsageBatch).toHaveBeenLastCalledWith([second]);
    act(() => changed?.({ sequence: 1 }));
    expect(benchmarkApi.getUsageLedger).toHaveBeenCalledTimes(2);
    view?.unmount();
    expect(stop).toHaveBeenCalledOnce();
    client.clear();
  });

  it("reads completed work in as Stats opens", async () => {
    vi.mocked(benchmarkApi.getUsageLedger)
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([entry, { ...entry, attemptId: "attempt-2" }]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Stats() {
      useFreshBenchmarkUsage();
      return <div>Stats</div>;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(projectBenchmarkUsageBatch).toHaveBeenCalledOnce(),
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <Shell />
        <Stats />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(projectBenchmarkUsageBatch).toHaveBeenCalledTimes(2),
    );
    client.clear();
  });

  it("reports failed judging from another page and reports its stop without notification spam", async () => {
    const active = { ...runSummary, state: "running", attention: null };
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([active]);
    vi.mocked(benchmarkApi.getUsageLedger).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(client.getQueryData(["benchmarks", "runs"])).toEqual([active]),
    );
    expect(toast.error).not.toHaveBeenCalled();
    const failed = {
      ...active,
      attention: {
        outcome: "pending_review",
        reason: "No judge panel: 1 eligible judge(s), at least 2 are required",
      },
    };
    act(() => client.setQueryData(["benchmarks", "runs"], [failed]));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Judging failed"),
      expect.objectContaining({
        description: "Cannot assemble a judge panel: 1 available, 2 required.",
        id: `benchmark-attention-${active.id}`,
      }),
    );
    act(() =>
      client.setQueryData(
        ["benchmarks", "runs"],
        [{ ...failed, revision: 20 }],
      ),
    );
    expect(toast.error).toHaveBeenCalledOnce();
    act(() =>
      client.setQueryData(
        ["benchmarks", "runs"],
        [{ ...failed, state: "needs_attention" }],
      ),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenLastCalledWith(
      expect.stringContaining("Run stopped"),
      expect.objectContaining({ id: `benchmark-attention-${active.id}` }),
    );
    client.clear();
  });

  it("does not announce historical failures on startup", async () => {
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([
      {
        ...runSummary,
        state: "completed",
        attention: {
          outcome: "pending_review",
          reason:
            "The judge panel is incomplete; every judge must return a valid score sheet",
        },
      },
    ]);
    vi.mocked(benchmarkApi.getUsageLedger).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(client.getQueryData(["benchmarks", "runs"])).toBeDefined(),
    );
    expect(toast.error).not.toHaveBeenCalled();
    client.clear();
  });

  it("reconciles events committed during listener registration", async () => {
    vi.mocked(benchmarkApi.eventsSince).mockResolvedValue([
      { sequence: 4, entityId: "run", kind: "terminal", createdAt: 1_000 },
    ]);
    vi.mocked(benchmarkApi.getUsageLedger).mockResolvedValue([entry]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(projectBenchmarkUsageBatch).toHaveBeenCalledOnce(),
    );
    expect(benchmarkApi.eventsSince).toHaveBeenCalledWith(0);
    expect(benchmarkApi.listen).toHaveBeenCalledOnce();
    client.clear();
  });

  it("refreshes history, boards and the catalog at most once per interval while a run saves attempts", async () => {
    let changed: ((change: BenchmarkChange) => void) | undefined;
    vi.mocked(benchmarkApi.listen).mockImplementation(async (callback) => {
      changed = callback;
      return () => {};
    });
    vi.mocked(benchmarkApi.getUsageLedger).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const history = ["benchmarks", "history", "model"];
    const catalog = ["benchmarks", "definitions"];
    const version = ["benchmarks", "version", "version-1"];
    const board = ["benchmarks", "leaderboard", { runId: null }];
    const runs = ["benchmarks", "runs"];
    const diagnostics = ["benchmarks", "diagnostics", "attempt-1"];
    for (const key of [history, catalog, version, board, runs, diagnostics])
      client.setQueryData(key, []);
    const stale = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated;
    render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(changed).toBeDefined());
    vi.useFakeTimers();
    try {
      for (const sequence of [1, 2, 3]) act(() => changed?.({ sequence }));
      expect(stale(runs)).toBe(true);
      expect(stale(history)).toBe(false);
      expect(stale(catalog)).toBe(false);
      expect(stale(version)).toBe(false);
      expect(stale(board)).toBe(false);
      expect(stale(diagnostics)).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(THROTTLED_REFRESH_MS));
      expect(stale(history)).toBe(true);
      expect(stale(catalog)).toBe(true);
      expect(stale(version)).toBe(true);
      expect(stale(board)).toBe(true);
      expect(stale(diagnostics)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    client.clear();
  });

  async function mounted() {
    let changed: ((change: BenchmarkChange) => void) | undefined;
    vi.mocked(benchmarkApi.listen).mockImplementation(async (callback) => {
      changed = callback;
      return () => {};
    });
    vi.mocked(benchmarkApi.getUsageLedger).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(changed).toBeDefined());
    const stale = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated;
    return {
      client,
      stale,
      notice: (change: BenchmarkChange) => act(() => changed?.(change)),
    };
  }

  it("coalesces a burst of change notices into one refresh per interval", async () => {
    const { client, notice } = await mounted();
    const runs = ["benchmarks", "runs"];
    client.setQueryData(runs, []);
    const initialReads = vi.mocked(benchmarkApi.listRuns).mock.calls.length;
    vi.useFakeTimers();
    try {
      // The first notice refreshes at once.
      notice({ sequence: 1 });
      expect(benchmarkApi.listRuns).toHaveBeenCalledTimes(initialReads + 1);
      client.setQueryData(runs, []);
      // Those that follow within the interval wait for its end, together.
      for (const sequence of [2, 3, 4]) {
        await act(() => vi.advanceTimersByTimeAsync(200));
        notice({ sequence });
      }
      expect(benchmarkApi.listRuns).toHaveBeenCalledTimes(initialReads + 1);
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS));
      expect(benchmarkApi.listRuns).toHaveBeenCalledTimes(initialReads + 2);
      client.setQueryData(runs, []);
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS * 2));
      expect(benchmarkApi.listRuns).toHaveBeenCalledTimes(initialReads + 2);
    } finally {
      vi.useRealTimers();
    }
    client.clear();
  });

  it("refreshes a run's own views only for the runs a notice names", async () => {
    const { client, stale, notice } = await mounted();
    const runA = ["benchmarks", "run", "run-a"];
    const attemptsA = ["benchmarks", "run-attempts", "run-a", ["attempt-1"]];
    const runB = ["benchmarks", "run", "run-b"];
    const runs = ["benchmarks", "runs"];
    for (const key of [runA, attemptsA, runB, runs])
      client.setQueryData(key, []);
    vi.useFakeTimers();
    try {
      notice({ sequence: 1, entityIds: ["run-a"] });
      expect(stale(runA)).toBe(true);
      expect(stale(attemptsA)).toBe(true);
      expect(stale(runB)).toBe(false);
      // Lists across runs refresh whatever changed.
      expect(stale(runs)).toBe(true);
      // A notice that names nothing may have changed any run.
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS));
      notice({ sequence: 2 });
      expect(stale(runB)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    client.clear();
  });

  it("applies a notice that arrives after a later one, and ignores an empty one", async () => {
    const { client, stale, notice } = await mounted();
    const runA = ["benchmarks", "run", "run-a"];
    const runB = ["benchmarks", "run", "run-b"];
    const runs = ["benchmarks", "runs"];
    for (const key of [runA, runB, runs]) client.setQueryData(key, []);
    vi.useFakeTimers();
    try {
      // The service can emit two notices in the other order; each names
      // only its own runs, so the earlier one still counts.
      notice({ sequence: 11, entityIds: ["run-b"] });
      notice({ sequence: 10, entityIds: ["run-a"] });
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS));
      expect(stale(runA)).toBe(true);
      expect(stale(runB)).toBe(true);
      // A notice with nothing committed since the last one changes nothing.
      for (const key of [runA, runB, runs]) client.setQueryData(key, []);
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS));
      notice({ sequence: 12, entityIds: [] });
      expect(stale(runs)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    client.clear();
  });

  it("fetches a run again when its change lands during its fetch", async () => {
    const { client, notice } = await mounted();
    const key = ["benchmarks", "run", "run-a"];
    let settle: (value: string) => void = () => {};
    const getRun = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((done) => {
            settle = done;
          }),
      )
      .mockResolvedValue("after the change");
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: getRun,
    });
    const unsubscribe = observer.subscribe(() => {});
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(1));
    // The fetch in flight started before the change; it is kept, and the run
    // fetches once more after it.
    notice({ sequence: 1, entityIds: ["run-a"] });
    settle("before the change");
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(client.getQueryData(key)).toBe("after the change"),
    );
    unsubscribe();
    client.clear();
  });
});
