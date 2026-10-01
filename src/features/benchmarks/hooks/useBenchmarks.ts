import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { benchmarkApi } from "../api/benchmarks";
import { projectBenchmarkUsage } from "@/features/stats/lib/usageLedger";
import { isDesktopRuntime } from "@/shared/api/distillStore";

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
