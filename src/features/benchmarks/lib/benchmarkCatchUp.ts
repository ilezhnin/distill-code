// A catch-up run fills the gaps of one leaderboard row. The row carries the
// configuration its newest attempt observed, including that attempt's runtime
// revision, which the runner refuses once the runtime changed. Catch-up
// therefore re-selects the row's model from today's inventory.
import type {
  Configuration,
  InventoryModel,
  LeaderboardRow,
  RunSummary,
} from "../types";
import { onMovingAlias } from "./benchmarkBoards";

export type CatchUpResolution =
  | { configuration: Configuration }
  | { issue: "missing" | "changed" }
  | { issue: "unavailable"; reason: string | null };

/** The row's model, effort, fast mode and billing, pinned to today's runtime. */
export function resolveCatchUpConfiguration(
  row: Configuration,
  inventory: InventoryModel[],
): CatchUpResolution {
  const model = inventory.find(
    (entry) => entry.configuration.modelId === row.modelId,
  );
  if (!model) return { issue: "missing" };
  // A moving alias under another name serves another model now, which is
  // another row: the row's own model cannot run again.
  if (
    onMovingAlias(row) &&
    (model.configuration.modelName ?? null) !== (row.modelName ?? null)
  )
    return { issue: "missing" };
  // Listed but blocked, for example while a changed runtime awaits verification.
  if (!model.available)
    return { issue: "unavailable", reason: model.reason ?? null };
  // "default" is the provider's own effort, the same ledger cell as none.
  const effort =
    row.effort &&
    (row.effort !== "default" || model.efforts.includes("default"))
      ? row.effort
      : null;
  if (
    (effort && !model.efforts.includes(effort)) ||
    (row.fastMode === true && !model.supportsFastMode) ||
    model.configuration.billingMode !== row.billingMode
  )
    return { issue: "changed" };
  const fastMode = model.supportsFastMode ? (row.fastMode ?? null) : null;
  const configuration: Configuration = {
    ...row,
    effort,
    fastMode,
    // The observed profile may carry an evidence label the runner never accepts.
    executionProfile: model.configuration.executionProfile,
    inventoryRevision: model.configuration.inventoryRevision,
    modelName: model.configuration.modelName ?? row.modelName ?? null,
  };
  configuration.id = [
    configuration.providerId,
    configuration.accountId ?? "",
    configuration.modelId,
    configuration.effort ?? "",
    configuration.fastMode ?? "",
  ].join(":");
  return { configuration };
}

/** Run states after which no further attempt starts. */
const FINISHED_RUN_STATES = new Set(["completed", "cancelled", "cancelling"]);

/** An effort as the ledger keys it: none and "default" are one cell. */
function ledgerEffort(effort: string | null | undefined): string {
  return !effort || effort === "default" ? "default" : effort;
}

/**
 * Whether a requested configuration produces attempts for this row. A request
 * that left effort or fast mode to the provider lands on what its attempts
 * acknowledged; before any has run, it may land on any of them.
 */
function requests(
  requested: Configuration,
  row: Configuration,
  run: RunSummary,
): boolean {
  if (
    requested.providerId !== row.providerId ||
    (requested.accountId ?? null) !== (row.accountId ?? null) ||
    requested.modelId !== row.modelId
  )
    return false;
  const observed = (run.observedSelections ?? []).filter(
    (selection) => selection.configurationId === requested.id,
  );
  const effort =
    ledgerEffort(requested.effort) !== "default"
      ? requested.effort === row.effort
      : observed.length === 0 ||
        observed.some(
          (selection) =>
            ledgerEffort(selection.effort) === ledgerEffort(row.effort),
        );
  const fastMode =
    requested.fastMode != null
      ? requested.fastMode === (row.fastMode ?? false)
      : observed.length === 0 ||
        observed.some(
          (selection) =>
            (selection.fastMode ?? false) === (row.fastMode ?? false),
        );
  return effort && fastMode;
}

/**
 * Splits the row's gaps into cases a catch-up may still run and cases an
 * unfinished run already plans for this model, so no gap is paid for twice.
 */
export function catchUpCases(
  row: LeaderboardRow,
  runs: RunSummary[],
): { owed: string[]; queuedRunId: string | null } {
  const missing = new Set(row.missingVersionIds);
  const queued = new Set<string>();
  let queuedRun: RunSummary | null = null;
  for (const run of runs) {
    if (run.request.preview || FINISHED_RUN_STATES.has(run.state)) continue;
    const matching = new Set(
      run.request.configurations
        .filter((entry) => requests(entry, row.configuration, run))
        .map((entry) => entry.id),
    );
    if (matching.size === 0) continue;
    // A run never retries a cell it settled, scored or not, so only its open
    // cells still plan the gap. A summary without open cells predates them
    // and counts the whole request.
    const planned = run.openCells
      ? run.openCells
          .filter((cell) => matching.has(cell.configurationId))
          .map((cell) => cell.versionId)
      : run.request.versionIds;
    const covered = planned.filter((id) => missing.has(id));
    if (covered.length === 0) continue;
    for (const id of covered) queued.add(id);
    if (!queuedRun || run.createdAt > queuedRun.createdAt) queuedRun = run;
  }
  return {
    owed: row.missingVersionIds.filter((id) => !queued.has(id)),
    queuedRunId: queuedRun?.id ?? null,
  };
}
