import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { useBenchmarkRuntime } from "../hooks/useBenchmarks";
import { projectBenchmarkUsage } from "@/features/stats/lib/usageLedger";
import type { UsageLedgerEntry } from "../types";

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
    let changed: ((event: { sequence: number }) => void) | undefined;
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
    act(() => changed?.({ sequence: 1 }));
    await waitFor(() => expect(projectBenchmarkUsage).toHaveBeenCalledTimes(2));
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
});
