import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { benchmarkApi } from "../api/benchmarks";
import { configurationKey } from "../lib/benchmarkBoards";
import { projectBenchmarkUsage } from "@/features/stats/lib/usageLedger";
import { isDesktopRuntime } from "@/shared/api/distillStore";
import type { CatalogEntry, Configuration, LeaderboardReport } from "../types";

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

export const historyKey = configurationKey;

export interface HistorySnapshot {
  id?: string;
  runId: string;
  createdAt: number;
  report: LeaderboardReport;
}

/** History is reconstructed once per candidate, including evaluation events. */
export function useConfigurationHistory(configuration: Configuration): {
  snapshots: HistorySnapshot[];
  loading: boolean;
} {
  const result = useQuery({
    queryKey: [...benchmarkKeys, "history", historyKey(configuration)],
    queryFn: () => benchmarkApi.getHistory(configuration),
    staleTime: 60_000,
  });
  return { snapshots: result.data ?? [], loading: result.isPending };
}
