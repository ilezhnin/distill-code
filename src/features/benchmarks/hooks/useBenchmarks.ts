import { useEffect, useMemo, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { benchmarkApi } from "../api/benchmarks";
import { projectBenchmarkUsage } from "@/features/stats/lib/usageLedger";
import { isDesktopRuntime } from "@/shared/api/distillStore";
import type {
  CatalogEntry,
  Configuration,
  LeaderboardReport,
  RunSummary,
} from "../types";

export const benchmarkKeys = ["benchmarks"] as const;

function useBenchmarkInvalidation(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let sequence = 0;
    const refresh = () => {
      void client.invalidateQueries({ queryKey: benchmarkKeys });
    };
    // Subscribe first, then reconcile committed events to close the mount gap.
    void benchmarkApi
      .listen((event) => {
        if (event.sequence <= sequence) return;
        sequence = event.sequence;
        refresh();
      })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        void benchmarkApi
          .eventsSince(sequence)
          .then((events) => {
            if (!cancelled && events.length) {
              sequence = Math.max(
                sequence,
                ...events.map((event) => event.sequence),
              );
              refresh();
            }
          })
          .catch(refresh);
      })
      .catch(refresh);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [client, enabled]);
}

export const useBenchmarkDefinitions = () =>
  useQuery({
    queryKey: [...benchmarkKeys, "definitions"],
    queryFn: benchmarkApi.listDefinitions,
  });
/** Mounted by AppShell so completed work reaches Stats from any view. */
export function useBenchmarkRuntime() {
  const enabled = isDesktopRuntime();
  useBenchmarkInvalidation(enabled);
  const projected = useRef(new Set<string>());
  const query = useQuery({
    queryKey: [...benchmarkKeys, "usage-ledger"],
    queryFn: benchmarkApi.getUsageLedger,
    enabled,
  });
  useEffect(() => {
    for (const record of query.data ?? []) {
      if (projected.current.has(record.attemptId)) continue;
      projectBenchmarkUsage(record);
      projected.current.add(record.attemptId);
    }
  }, [query.data]);
}

export const useBenchmarkRuns = () =>
  useQuery({
    queryKey: [...benchmarkKeys, "runs"],
    queryFn: benchmarkApi.listRuns,
  });

/** Dated vendor facts; an empty catalog is seeded by the service on first read. */
export function useModelCatalog() {
  const catalog = useQuery({
    queryKey: [...benchmarkKeys, "catalog"],
    queryFn: benchmarkApi.listCatalog,
  });
  return catalog.data ?? EMPTY_CATALOG;
}
const EMPTY_CATALOG: CatalogEntry[] = [];

export const modelNameKey = (configuration: {
  providerId: string;
  modelId: string;
}) => `${configuration.providerId}/${configuration.modelId}`;

/**
 * Display names from recorded inventory probes, newest probe winning, so rows
 * from runs that predate the stored name still read as the bridge names them.
 */
export function useModelNames(): Map<string, string> {
  const observations = useQuery({
    queryKey: [...benchmarkKeys, "observations"],
    queryFn: benchmarkApi.getCandidateObservations,
  });
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const observation of [...(observations.data ?? [])].sort(
      (a, b) => a.capturedAt - b.capturedAt,
    )) {
      for (const model of observation.models) {
        if (model.name && model.name !== model.configuration.modelId)
          names.set(modelNameKey(model.configuration), model.name);
      }
    }
    return names;
  }, [observations.data]);
}

/** The identity a history follows: provider, account, model, effort and fast mode; not the runtime revision. */
export function historyKey(configuration: Configuration): string {
  return [
    configuration.providerId,
    configuration.accountId ?? "",
    configuration.modelId,
    configuration.effort ?? "",
    String(configuration.fastMode),
  ].join("/");
}

export interface HistorySnapshot {
  runId: string;
  createdAt: number;
  report: LeaderboardReport;
}

const HISTORY_RUNS = 24;

/**
 * The ledger as it stood when each completed run finished, oldest first, so a
 * model page can chart a configuration's points on the current pool over
 * time and open any of those states.
 */
export function useConfigurationHistory(runs: RunSummary[]): {
  snapshots: HistorySnapshot[];
  loading: boolean;
} {
  const chosen = runs
    .filter((run) => run.state === "completed" && !run.request.preview)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, HISTORY_RUNS);
  const results = useQueries({
    queries: chosen.map((run) => ({
      queryKey: [
        ...benchmarkKeys,
        "leaderboard",
        {
          asOf: run.updatedAt,
          runId: null,
          versionIds: null,
          offset: 0,
          limit: 500,
        },
      ],
      queryFn: () =>
        benchmarkApi.getLeaderboard({
          asOf: run.updatedAt,
          runId: null,
          versionIds: null,
          offset: 0,
          limit: 500,
        }),
      staleTime: 60_000,
    })),
  });
  const snapshots: HistorySnapshot[] = [];
  results.forEach((result, index) => {
    if (result.data)
      snapshots.push({
        runId: chosen[index].id,
        createdAt: chosen[index].updatedAt,
        report: result.data,
      });
  });
  snapshots.sort((a, b) => a.createdAt - b.createdAt);
  return { snapshots, loading: results.some((result) => result.isPending) };
}
