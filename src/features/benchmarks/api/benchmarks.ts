import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Attempt,
  AttemptSummary,
  BenchmarkDefinition,
  BenchmarkDraft,
  BenchmarkEvent,
  BenchmarkRun,
  BenchmarkVersion,
  CandidateObservation,
  Capability,
  InventoryModel,
  RunPreview,
  RunRequest,
  RunSummary,
  ValidationReport,
} from "../types";
import type {
  Baseline,
  Comparison,
  ExportResult,
  LeaderboardReport,
  ResultQuery,
  Schedule,
  UsageSample,
  UsageComparison,
  UsageLedgerEntry,
  RoutingEvidence,
  RoutingEvidenceQuery,
} from "../types";

export function benchmarkErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
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
  startRun: (request: RunRequest) =>
    invoke<BenchmarkRun>("benchmark_start_run", { request }),
  listRuns: () => invoke<RunSummary[]>("benchmark_list_runs"),
  listAttempts: (query: ResultQuery) =>
    invoke<AttemptSummary[]>("benchmark_list_attempts", { query }),
  getRun: (id: string) => invoke<BenchmarkRun>("benchmark_get_run", { id }),
  pauseRun: (id: string) => invoke<BenchmarkRun>("benchmark_pause_run", { id }),
  resumeRun: (id: string) =>
    invoke<BenchmarkRun>("benchmark_resume_run", { id }),
  cancelRun: (id: string) =>
    invoke<BenchmarkRun>("benchmark_cancel_run", { id }),
  getEvidence: (id: string) =>
    invoke<Attempt>("benchmark_get_evidence", { id }),
  eventsSince: (afterSequence: number) =>
    invoke<BenchmarkEvent[]>("benchmark_events_since", { afterSequence }),
  getCapabilities: () => invoke<Capability[]>("benchmark_get_capabilities"),
  getCandidateObservations: () =>
    invoke<CandidateObservation[]>("benchmark_get_candidate_observations"),
  getLeaderboard: (query: ResultQuery) =>
    invoke<LeaderboardReport>("benchmark_get_leaderboard", { query }),
  getRoutingEvidence: (query: RoutingEvidenceQuery) =>
    invoke<RoutingEvidence>("benchmark_get_routing_evidence", { query }),
  getUsageSeries: (query: ResultQuery) =>
    invoke<UsageSample[]>("benchmark_get_usage_series", { query }),
  getUsageLedger: () =>
    invoke<UsageLedgerEntry[]>("benchmark_get_usage_ledger"),
  getUsageComparisons: (baselineId: string) =>
    invoke<UsageComparison[]>("benchmark_get_usage_comparisons", {
      baselineId,
    }),
  listBaselines: () => invoke<Baseline[]>("benchmark_list_baselines"),
  createBaseline: (name: string, runIds: string[], threshold: number) =>
    invoke<Baseline>("benchmark_create_baseline", { name, runIds, threshold }),
  getComparisons: (baselineId: string, query: ResultQuery) =>
    invoke<Comparison[]>("benchmark_get_comparisons", { baselineId, query }),
  submitReview: (id: string, score: number, reason: string) =>
    invoke<Attempt>("benchmark_submit_review", { id, score, reason }),
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
