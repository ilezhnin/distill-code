import { useEffect, useMemo, useRef } from "react";
import { type Query, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { benchmarkApi } from "../api/benchmarks";
import { benchmarkProgress } from "../lib/benchmarkActivity";
import { configurationKey } from "../lib/benchmarkBoards";
import { attentionLabel, modelDisplayName } from "../lib/benchmarkLabels";
import { judgingFailureLabel } from "../lib/benchmarkRunIssues";
import { projectBenchmarkUsageBatch } from "@/features/stats/lib/usageLedger";
import { isDesktopRuntime } from "@/shared/api/flockStore";
import type {
  CatalogEntry,
  Configuration,
  LeaderboardReport,
  PoolRelease,
  RunSummary,
} from "../types";

export const benchmarkKeys = ["benchmarks"] as const;

/**
 * A running batch saves an attempt every few seconds and each save sends an
 * event, so events refresh the views at most this often: the first at once,
 * those that follow together once the interval since the last refresh ends.
 */
export const COALESCED_REFRESH_MS = 1_500;
/**
 * History, boards and the other analyses read the whole ledger and the
 * catalog reads every manifest, so events refresh them at most this often.
 * The app's own edits still refresh at once.
 */
export const THROTTLED_REFRESH_MS = 15_000;
/**
 * The usage ledger reads every attempt and evaluation, and Stats keeps what
 * it projected, so events never refresh it: it follows on this interval and
 * whenever Stats opens.
 */
export const USAGE_LEDGER_REFRESH_MS = 300_000;
/** Recover a missed terminal event without reloading the full usage ledger. */
export const RUN_STATUS_REFRESH_MS = 15_000;
const usageLedgerKey = [...benchmarkKeys, "usage-ledger"] as const;
const OFF_EVENTS = new Set(["usage-ledger", "diagnostics"]);
const onEvents = (query: { queryKey: readonly unknown[] }) =>
  !OFF_EVENTS.has(String(query.queryKey[1]));
const THROTTLED_QUERIES = new Set([
  "history",
  "definitions",
  "definition",
  "version",
  "leaderboard",
  "learning-candidates",
  "case-stats",
  "selector-harness",
  "class-policies",
  "designs",
]);
const throttled = (query: { queryKey: readonly unknown[] }) =>
  THROTTLED_QUERIES.has(String(query.queryKey[1]));
/** Views of one run, keyed by its id; a notice names the runs it changed. */
const RUN_QUERIES = new Set(["run", "run-attempts"]);
/** Whether a notice naming `changed` (null: anything) touches `query`. */
const touched = (
  query: { queryKey: readonly unknown[] },
  changed: ReadonlySet<string> | null,
) =>
  changed === null ||
  !RUN_QUERIES.has(String(query.queryKey[1])) ||
  changed.has(String(query.queryKey[2]));

function useBenchmarkInvalidation(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let sequence = 0;
    let throttledTimer: ReturnType<typeof setTimeout> | undefined;
    let coalescedTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshedAt = -Infinity;
    // What the notices since the last refresh changed; null: anything.
    let changed: Set<string> | null = new Set();
    // A refresh already running finishes rather than being dropped for a new
    // one: the service would compute the dropped request anyway, and the next
    // notice refreshes again.
    const keepRunning = { cancelRefetch: false } as const;
    // A query fetching already keeps that fetch, which may have started
    // before the change: it fetches once more when that fetch settles. The
    // heavy throttled queries wait for their next interval instead.
    const invalidate = (
      predicate: (query: Query) => boolean,
      again: boolean,
    ) => {
      const running = again
        ? client.getQueryCache().findAll({
            queryKey: benchmarkKeys,
            fetchStatus: "fetching",
            predicate,
          })
        : [];
      void client
        .invalidateQueries({ queryKey: benchmarkKeys, predicate }, keepRunning)
        .then(() => {
          if (cancelled || running.length === 0) return;
          void client.refetchQueries(
            {
              queryKey: benchmarkKeys,
              type: "active",
              predicate: (query) => running.includes(query),
            },
            keepRunning,
          );
        });
    };
    const refresh = (scope: ReadonlySet<string> | null) => {
      invalidate(
        (query) =>
          onEvents(query) && !throttled(query) && touched(query, scope),
        true,
      );
      if (throttledTimer !== undefined) return;
      throttledTimer = setTimeout(() => {
        throttledTimer = undefined;
        if (cancelled) return;
        invalidate((query) => onEvents(query) && throttled(query), false);
      }, THROTTLED_REFRESH_MS);
    };
    const flush = () => {
      coalescedTimer = undefined;
      if (cancelled) return;
      refreshedAt = Date.now();
      const scope = changed;
      changed = new Set();
      refresh(scope);
    };
    const note = (entityIds: readonly string[] | undefined) => {
      // A notice that names nothing committed since the one before changed
      // nothing.
      if (Array.isArray(entityIds) && entityIds.length === 0) return;
      if (!Array.isArray(entityIds) || changed === null) changed = null;
      else for (const id of entityIds) changed.add(id);
      if (coalescedTimer !== undefined) return;
      const wait = refreshedAt + COALESCED_REFRESH_MS - Date.now();
      if (wait <= 0) flush();
      else coalescedTimer = setTimeout(flush, wait);
    };
    const refreshAll = () => note(undefined);
    // Subscribe first, then reconcile committed events to close the mount gap.
    void benchmarkApi
      .listen((change) => {
        // Notices can arrive out of order, and each names only its own
        // changes, so none is dropped; the sequence marks how far the
        // reconcile below reached.
        sequence = Math.max(sequence, change.sequence);
        note(change.entityIds);
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
              refreshAll();
            }
          })
          .catch(refreshAll);
      })
      .catch(refreshAll);
    return () => {
      cancelled = true;
      clearTimeout(throttledTimer);
      clearTimeout(coalescedTimer);
      unlisten?.();
    };
  }, [client, enabled]);
}

/** The catalog as summaries: no task contents, whatever its size. */
export const useBenchmarkDefinitions = () =>
  useQuery({
    queryKey: [...benchmarkKeys, "definitions"],
    queryFn: benchmarkApi.listDefinitions,
  });

/** One test with its full draft and versions, for its detail and editor. */
export const useBenchmarkDefinition = (id: string | undefined) =>
  useQuery({
    queryKey: [...benchmarkKeys, "definition", id],
    queryFn: () => benchmarkApi.getDefinition(id as string),
    enabled: Boolean(id),
  });

/** One published version's full manifest. */
export const useBenchmarkVersion = (id: string | undefined) =>
  useQuery({
    queryKey: [...benchmarkKeys, "version", id],
    queryFn: () => benchmarkApi.getVersion(id as string),
    enabled: Boolean(id),
  });
/** Mounted by AppShell so completed work reaches Stats from any view. */
export function useBenchmarkRuntime() {
  const enabled = isDesktopRuntime();
  useBenchmarkInvalidation(enabled);
  useBenchmarkRunNotifications(enabled);
  const projected = useRef(new Set<string>());
  const query = useQuery({
    queryKey: usageLedgerKey,
    queryFn: benchmarkApi.getUsageLedger,
    enabled,
    refetchInterval: USAGE_LEDGER_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const records = (query.data ?? []).filter(
      (record) => !projected.current.has(record.attemptId),
    );
    if (records.length === 0) return;
    projectBenchmarkUsageBatch(records);
    for (const record of records) projected.current.add(record.attemptId);
  }, [query.data]);
}

/** Reconcile active runs and report failures from every page, once per cause and stop. */
function useBenchmarkRunNotifications(enabled: boolean) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const runs = useQuery({
    queryKey: [...benchmarkKeys, "runs"],
    queryFn: benchmarkApi.listRuns,
    enabled,
    refetchInterval: (query) =>
      !query.state.data ||
      query.state.data.some((run) =>
        ["running", "pausing", "cancelling"].includes(run.state),
      )
        ? RUN_STATUS_REFRESH_MS
        : false,
    refetchIntervalInBackground: true,
  });
  const previous = useRef<Map<string, RunSummary> | null>(null);
  const warned = useRef(new Set<string>());
  useEffect(() => {
    if (!runs.data) return;
    if (previous.current) {
      for (const run of runs.data) {
        const before = previous.current.get(run.id);
        if (
          before &&
          (before.revision !== run.revision ||
            before.state !== run.state ||
            before.settledCount !== run.settledCount ||
            before.attention?.reason !== run.attention?.reason ||
            before.warning?.attemptId !== run.warning?.attemptId)
        ) {
          void client.invalidateQueries({
            queryKey: benchmarkKeys,
            predicate: (query) =>
              RUN_QUERIES.has(String(query.queryKey[1])) &&
              query.queryKey[2] === run.id,
          });
        }
        if (run.request.preview) continue;
        const model = [
          ...new Set(
            run.request.configurations.map((entry) => modelDisplayName(entry)),
          ),
        ].join(", ");
        if (
          run.warning &&
          !warned.current.has(
            `${run.id}:${run.warning.attemptId}:${run.warning.kind}`,
          )
        ) {
          toast.warning(t("runIssues.temporaryWarning", { model }), {
            id: `benchmark-warning-${run.id}`,
            description: t(
              run.warning.kind === "rate_limited"
                ? "runIssues.rateLimited"
                : run.warning.kind === "quota_wait"
                  ? "runIssues.quotaWait"
                  : "runIssues.providerOverloaded",
            ),
            duration: 6000,
            closeButton: true,
            classNames: { icon: "text-warning" },
          });
        }
        if (!run.attention) continue;
        const stopped = ["needs_attention", "completed", "paused"].includes(
          run.state,
        );
        if (
          before?.attention?.reason === run.attention.reason &&
          ["needs_attention", "completed", "paused"].includes(before.state) ===
            stopped
        )
          continue;
        toast.error(
          t(
            stopped
              ? "runIssues.stopped"
              : run.attention.outcome === "pending_review"
                ? "runIssues.notification"
                : "runIssues.executionFailed",
            {
              model,
            },
          ),
          {
            id: `benchmark-attention-${run.id}`,
            description:
              run.attention.outcome === "pending_review"
                ? judgingFailureLabel(t, run.attention.reason)
                : attentionLabel(t, run),
            duration: 12_000,
            closeButton: true,
          },
        );
      }
    }
    previous.current = new Map(runs.data.map((run) => [run.id, run]));
    for (const run of runs.data) {
      if (run.warning)
        warned.current.add(
          `${run.id}:${run.warning.attemptId}:${run.warning.kind}`,
        );
    }
  }, [runs.data, t, client]);
}

/** Mounted by Stats: completed benchmark work is read in as Stats opens. */
export function useFreshBenchmarkUsage() {
  const client = useQueryClient();
  useEffect(() => {
    void client.invalidateQueries({ queryKey: usageLedgerKey });
  }, [client]);
}

export const useBenchmarkRuns = () =>
  useQuery({
    queryKey: [...benchmarkKeys, "runs"],
    queryFn: benchmarkApi.listRuns,
  });

export const useWorkflowCampaigns = () =>
  useQuery({
    queryKey: [...benchmarkKeys, "workflow-campaigns"],
    queryFn: benchmarkApi.listWorkflowCampaigns,
    enabled: isDesktopRuntime(),
    // Events refresh campaigns as they change; the poll only keeps waits
    // that pass without an event current.
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 4000,
  });

/** Progress for dispatching runs and unfinished campaigns, including a full pause. */
export function useBenchmarkProgress() {
  const campaigns = useWorkflowCampaigns();
  const runs = useQuery({
    queryKey: [...benchmarkKeys, "runs"],
    queryFn: benchmarkApi.listRuns,
    enabled: isDesktopRuntime(),
  });
  return useMemo(() => {
    return benchmarkProgress(runs.data ?? [], campaigns.data ?? []);
  }, [runs.data, campaigns.data]);
}

/** Every pool release, oldest first. */
export function useBenchmarkReleases() {
  const releases = useQuery({
    queryKey: [...benchmarkKeys, "releases"],
    queryFn: benchmarkApi.listReleases,
  });
  return releases.data ?? EMPTY_RELEASES;
}
const EMPTY_RELEASES: PoolRelease[] = [];

/** Every native provider's data use, as the service reads the settings. */
export const PROVIDER_DATA_USE_KEY = [
  ...benchmarkKeys,
  "provider-data-use",
] as const;

/**
 * What each native provider may do with what benchmark turns send it. The
 * defaults live in the backend, so the rows are read from it rather than
 * worked out here.
 */
export const useProviderDataUse = () =>
  useQuery({
    queryKey: PROVIDER_DATA_USE_KEY,
    queryFn: () => benchmarkApi.providerDataUse(),
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
  recalculatedReport?: LeaderboardReport;
  backfilledVersionIds?: string[];
  revisedVersionIds?: string[];
}

/** The model page's current-pool view; immutable dated reports stay in full history. */
export interface ModelHistoryViewPoint {
  id: string;
  runId: string;
  createdAt: number;
  recalculatedReport: LeaderboardReport;
  backfilledVersionIds: string[];
  revisedVersionIds: string[];
}

/** Dated evidence and current-pool recalculations share one candidate query. */
export function useConfigurationHistory(
  configuration: Configuration,
  model = false,
): {
  snapshots: HistorySnapshot[];
  loading: boolean;
  /** Why the history could not be read; null while it loads or once read. */
  error: unknown;
  /** True while a read, a retry included, is under way. */
  reading: boolean;
  retry: () => void;
} {
  const result = useQuery({
    queryKey: [...benchmarkKeys, "history", historyKey(configuration), model],
    queryFn: () => benchmarkApi.getHistory(configuration, model),
    staleTime: 60_000,
    // A read takes seconds; a failure is shown at once, with a retry.
    retry: 0,
  });
  return {
    snapshots: result.data ?? [],
    loading: result.isPending,
    error: result.error,
    reading: result.isFetching,
    retry: () => void result.refetch(),
  };
}

/** Same observation dates as full model history, without unused dated boards. */
export function useModelHistoryView(configuration: Configuration): {
  snapshots: ModelHistoryViewPoint[];
  loading: boolean;
  error: unknown;
  reading: boolean;
  retry: () => void;
} {
  const result = useQuery({
    // Keep history invalidation/throttling while separating the response shapes.
    queryKey: [
      ...benchmarkKeys,
      "history",
      historyKey(configuration),
      "model-view",
    ],
    queryFn: () => benchmarkApi.getModelHistoryView(configuration),
    staleTime: 60_000,
    retry: 0,
  });
  return {
    snapshots: result.data ?? [],
    loading: result.isPending,
    error: result.error,
    reading: result.isFetching,
    retry: () => void result.refetch(),
  };
}
