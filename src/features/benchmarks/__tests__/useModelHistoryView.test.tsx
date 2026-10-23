import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  historyKey,
  useConfigurationHistory,
  useModelHistoryView,
  type HistorySnapshot,
  type ModelHistoryViewPoint,
} from "../hooks/useBenchmarks";
import { cohort, configuration, leaderboardRow } from "./fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const full: HistorySnapshot[] = [
  {
    id: "old-observation",
    runId: "old-run",
    createdAt: 1_000,
    report: { cohort, rows: [leaderboardRow({ points: 100 })] },
  },
];
const view: ModelHistoryViewPoint[] = [
  {
    id: "observation",
    runId: "run",
    createdAt: 2_000,
    recalculatedReport: { cohort, rows: [leaderboardRow({ points: 700 })] },
    backfilledVersionIds: ["borrowed-case"],
    revisedVersionIds: ["reviewed-case"],
  },
];

const clients: QueryClient[] = [];
function fixture() {
  const client = new QueryClient();
  clients.push(client);
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

it("uses the dedicated read without consuming full-history caches and retains history invalidation", async () => {
  const { client, wrapper } = fixture();
  const prefix = ["benchmarks", "history", historyKey(configuration)];
  client.setQueryData([...prefix, false], full);
  client.setQueryData([...prefix, true], full);
  vi.mocked(invoke).mockResolvedValue(view);
  const { result } = renderHook(
    () => ({
      projected: useModelHistoryView(configuration),
      configuration: useConfigurationHistory(configuration),
      model: useConfigurationHistory(configuration, true),
    }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.projected.snapshots).toEqual(view));
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "benchmark_get_model_history_view",
    { configuration },
  );
  expect(result.current.configuration.snapshots).toEqual(full);
  expect(result.current.model.snapshots).toEqual(full);
  const queries = client.getQueryCache().findAll({ queryKey: prefix });
  expect(queries).toHaveLength(3);
  for (const query of queries) {
    expect(query.options).toMatchObject({ staleTime: 60_000, retry: 0 });
  }
  await act(() =>
    client.invalidateQueries({
      queryKey: ["benchmarks", "history"],
      refetchType: "none",
    }),
  );
  expect(queries.every((query) => query.state.isInvalidated)).toBe(true);
});

it("shows a failed read immediately and retries explicitly with the same loading semantics", async () => {
  const { wrapper } = fixture();
  let fail!: (reason: Error) => void;
  let finish!: (value: ModelHistoryViewPoint[]) => void;
  vi.mocked(invoke)
    .mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  const { result } = renderHook(() => useModelHistoryView(configuration), {
    wrapper,
  });
  expect(result.current).toMatchObject({
    snapshots: [],
    loading: true,
    reading: true,
    error: null,
  });
  const error = new Error("invented store busy");
  await act(async () => fail(error));
  await waitFor(() => expect(result.current.error).toBe(error));
  expect(result.current).toMatchObject({ loading: false, reading: false });
  expect(invoke).toHaveBeenCalledTimes(1);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.reading).toBe(true));
  await act(async () => finish(view));
  await waitFor(() => expect(result.current.snapshots).toEqual(view));
  expect(result.current).toMatchObject({
    loading: false,
    reading: false,
    error: null,
  });
  expect(invoke).toHaveBeenCalledTimes(2);
});
