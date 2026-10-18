import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import {
  COALESCED_REFRESH_MS,
  THROTTLED_REFRESH_MS,
  useBenchmarkRuntime,
} from "../hooks/useBenchmarks";
import { projectBenchmarkUsage } from "@/features/stats/lib/usageLedger";
import type { BenchmarkChange, UsageLedgerEntry } from "../types";

vi.mock("../api/benchmarks", () => ({
  benchmarkApi: {
    getUsageLedger: vi.fn(),
    eventsSince: vi.fn(),
    listen: vi.fn(),
  },
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  projectBenchmarkUsage: vi.fn(),
}));
vi.mock("@/shared/api/distillStore", () => ({
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
    const view = render(
      <QueryClientProvider client={client}>
        <Shell />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(projectBenchmarkUsage).toHaveBeenCalledOnce());
    expect(projectBenchmarkUsage).toHaveBeenCalledWith(entry);
    // The usage ledger reads every attempt, so events refresh it once per
    // interval, not at every saved attempt.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => changed?.({ sequence: 1 }));
      await act(() => vi.advanceTimersByTimeAsync(THROTTLED_REFRESH_MS));
      await waitFor(() =>
        expect(projectBenchmarkUsage).toHaveBeenCalledTimes(2),
      );
    } finally {
      vi.useRealTimers();
    }
    expect(projectBenchmarkUsage).toHaveBeenLastCalledWith(second);
    act(() => changed?.({ sequence: 1 }));
    expect(benchmarkApi.getUsageLedger).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
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
    await waitFor(() => expect(projectBenchmarkUsage).toHaveBeenCalledOnce());
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
    for (const key of [history, catalog, version, board, runs])
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
      await act(() => vi.advanceTimersByTimeAsync(THROTTLED_REFRESH_MS));
      expect(stale(history)).toBe(true);
      expect(stale(catalog)).toBe(true);
      expect(stale(version)).toBe(true);
      expect(stale(board)).toBe(true);
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
    const { client, stale, notice } = await mounted();
    const runs = ["benchmarks", "runs"];
    client.setQueryData(runs, []);
    vi.useFakeTimers();
    try {
      // The first notice refreshes at once.
      notice({ sequence: 1 });
      expect(stale(runs)).toBe(true);
      client.setQueryData(runs, []);
      // Those that follow within the interval wait for its end, together.
      for (const sequence of [2, 3, 4]) {
        await act(() => vi.advanceTimersByTimeAsync(200));
        notice({ sequence });
      }
      expect(stale(runs)).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS));
      expect(stale(runs)).toBe(true);
      client.setQueryData(runs, []);
      await act(() => vi.advanceTimersByTimeAsync(COALESCED_REFRESH_MS * 2));
      expect(stale(runs)).toBe(false);
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
