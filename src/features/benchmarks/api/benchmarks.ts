import type { HistorySnapshot } from "../hooks/useBenchmarks";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { REQUIRED_REPETITIONS } from "../lib/benchmarkPlan";
import type {
  Attempt,
  AttemptSummary,
  DesignEntry,
  BenchmarkDefinition,
  BenchmarkDraft,
  BenchmarkEvent,
  BenchmarkRun,
  BenchmarkVersion,
  CandidateObservation,
  CaseStats,
  SelectorHarnessQuery,
  SelectorHarnessReport,
  Capability,
  Configuration,
  CatalogEntry,
  InventoryModel,
  PoolRelease,
  RunPreview,
  RunRequest,
  RunSummary,
  ValidationReport,
} from "../types";
import type {
  ExportResult,
  LeaderboardReport,
  ResultQuery,
  Schedule,
  UsageLedgerEntry,
  RoutingEvidence,
  RoutingEvidenceQuery,
} from "../types";

export function benchmarkErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}

async function listCompletedDesigns(
  query: ResultQuery,
): Promise<DesignEntry[]> {
  const entries = (
    await invoke<DesignEntry[]>("benchmark_list_designs", { query })
  ).filter((entry) => entry.phase === "terminal" && entry.score != null);
  const legacy = entries.filter((entry) => entry.completedRepetitions == null);
  if (legacy.length > 0) {
    // The UI may update while an older backend finishes a paid run. Read its
    // existing scoring endpoint until it can restart without losing that work.
    const definitions = await benchmarkApi.listDefinitions();
    const versions = new Map(
      definitions.flatMap((definition) =>
        definition.versions.map((version) => [version.id, version] as const),
      ),
    );
    await Promise.all(
      [...new Set(legacy.map((entry) => entry.runId))].map(async (id) => {
        const run = await benchmarkApi.getRun(id);
        const own = legacy.filter((entry) => entry.runId === id);
        const attempts = run.attempts.filter((attempt) =>
          own.some(
            (entry) =>
              entry.versionId === attempt.versionId &&
              entry.configuration.id === attempt.configuration.id,
          ),
        );
        const scored = new Set<string>();
        for (let offset = 0; offset < attempts.length; offset += 100) {
          const summaries = await benchmarkApi.listAttempts({
            runId: id,
            attemptIds: attempts.slice(offset, offset + 100).map((a) => a.id),
            asOf: query.asOf,
            limit: 100,
          });
          for (const attempt of summaries) {
            if (attempt.phase === "terminal" && attempt.score != null)
              scored.add(attempt.id);
          }
        }
        for (const entry of own) {
          entry.requiredRepetitions = Math.max(
            REQUIRED_REPETITIONS,
            run.request.repetitions,
            versions.get(entry.versionId)?.manifest.repetitions ?? Infinity,
          );
          entry.completedRepetitions = new Set(
            attempts
              .filter(
                (attempt) =>
                  attempt.versionId === entry.versionId &&
                  attempt.configuration.id === entry.configuration.id &&
                  scored.has(attempt.id),
              )
              .map((attempt) => attempt.repetition),
          ).size;
        }
      }),
    );
  }
  return entries.filter(
    (entry) =>
      (entry.completedRepetitions ?? 0) >=
      Math.max(REQUIRED_REPETITIONS, entry.requiredRepetitions ?? Infinity),
  );
}

export const benchmarkApi = {
  listDefinitions: () =>
    invoke<BenchmarkDefinition[]>("benchmark_list_definitions"),
  saveDraft: (
    id: string | null,
    expectedRevision: number | null,
    draft: BenchmarkDraft,
  ) =>
    invoke<BenchmarkDefinition>("benchmark_save_draft", {
      id,
      expectedRevision,
      draft,
    }),
  validateDraft: (draft: BenchmarkDraft) =>
    invoke<ValidationReport>("benchmark_validate_draft", { draft }),
  publishVersion: (id: string, expectedRevision: number) =>
    invoke<BenchmarkVersion>("benchmark_publish_version", {
      id,
      expectedRevision,
    }),
  duplicateDefinition: (id: string) =>
    invoke<BenchmarkDefinition>("benchmark_duplicate_definition", { id }),
  archiveDefinition: (id: string, archived: boolean) =>
    invoke<BenchmarkDefinition>("benchmark_archive_definition", {
      id,
      archived,
    }),
  generateVariant: (family: string, seed: number) =>
    invoke<BenchmarkDraft>("benchmark_generate_variant", { family, seed }),
  importDefinition: (draft: BenchmarkDraft) =>
    invoke<BenchmarkDefinition>("benchmark_import_definition", { draft }),
  previewRun: (request: RunRequest) =>
    invoke<RunPreview>("benchmark_preview_run", { request }),
  startRun: (request: RunRequest, replaceRunId?: string) =>
    invoke<BenchmarkRun>("benchmark_start_run", {
      request,
      ...(replaceRunId ? { replaceRunId } : {}),
    }),
  listRuns: () => invoke<RunSummary[]>("benchmark_list_runs"),
  listAttempts: (query: ResultQuery) =>
    invoke<AttemptSummary[]>("benchmark_list_attempts", { query }),
  listDesigns: listCompletedDesigns,
  getRun: (id: string) => invoke<BenchmarkRun>("benchmark_get_run", { id }),
  pauseRun: (id: string) => invoke<BenchmarkRun>("benchmark_pause_run", { id }),
  resumeRun: (id: string) =>
    invoke<BenchmarkRun>("benchmark_resume_run", { id }),
  cancelRun: (id: string) =>
    invoke<BenchmarkRun>("benchmark_cancel_run", { id }),
  /** Adds tests to a run inside its window and goes on with it; with none, a resume. */
  extendRun: (id: string, versionIds: string[]) =>
    invoke<BenchmarkRun>("benchmark_extend_run", { id, versionIds }),
  getEvidence: (id: string) =>
    invoke<Attempt>("benchmark_get_evidence", { id }),
  eventsSince: (afterSequence: number) =>
    invoke<BenchmarkEvent[]>("benchmark_events_since", { afterSequence }),
  getCapabilities: () => invoke<Capability[]>("benchmark_get_capabilities"),
  getCandidateObservations: () =>
    invoke<CandidateObservation[]>("benchmark_get_candidate_observations"),
  listCatalog: () => invoke<CatalogEntry[]>("benchmark_list_catalog"),
  saveCatalogEntry: (entry: CatalogEntry) =>
    invoke<CatalogEntry>("benchmark_save_catalog_entry", { entry }),
  deleteCatalogEntry: (id: string) =>
    invoke<void>("benchmark_delete_catalog_entry", { id }),
  getLeaderboard: (query: ResultQuery) =>
    invoke<LeaderboardReport>("benchmark_get_leaderboard", { query }),
  /** The held-out harness of one class: the selector against fixed policies. */
  selectorHarness: (query: SelectorHarnessQuery) =>
    invoke<SelectorHarnessReport>("benchmark_selector_harness", { query }),
  /** Discrimination and flakiness of every pool case over the standing cells. */
  getCaseStats: () => invoke<CaseStats[]>("benchmark_get_case_stats"),
  getHistory: (configuration: Configuration) =>
    invoke<HistorySnapshot[]>("benchmark_get_history", { configuration }),
  getRoutingEvidence: (query: RoutingEvidenceQuery) =>
    invoke<RoutingEvidence>("benchmark_get_routing_evidence", { query }),
  getUsageLedger: () =>
    invoke<UsageLedgerEntry[]>("benchmark_get_usage_ledger"),
  listReleases: () => invoke<PoolRelease[]>("benchmark_list_releases"),
  /** Freezes live training/held-out versions; the name defaults to the next vN. */
  createRelease: (name: string | null) =>
    invoke<PoolRelease>("benchmark_create_release", { name }),
  submitReview: (
    id: string,
    score: number,
    reason: string,
    criteria: Record<string, number> | null = null,
  ) =>
    invoke<Attempt>("benchmark_submit_review", { id, score, reason, criteria }),
  rescore: (id: string) => invoke<Attempt>("benchmark_rescore", { id }),
  exportDataset: (includeHeldOut: boolean) =>
    invoke<ExportResult>("benchmark_export_dataset", { includeHeldOut }),
  listSchedules: () => invoke<Schedule[]>("benchmark_list_schedules"),
  saveSchedule: (schedule: Schedule) =>
    invoke<Schedule>("benchmark_save_schedule", { schedule }),
  getInventory: (
    providerId: string,
    accountId: string | null,
    refresh = false,
  ) =>
    invoke<InventoryModel[]>("benchmark_get_inventory", {
      providerId,
      accountId,
      refresh,
    }),
  listen: (callback: (event: Pick<BenchmarkEvent, "sequence">) => void) =>
    listen<Pick<BenchmarkEvent, "sequence">>("benchmark-changed", (event) =>
      callback(event.payload),
    ),
};
