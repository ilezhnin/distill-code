import type {
  Configuration,
  LeaderboardReport,
  LeaderboardRow,
  RunSummary,
} from "../types";
import { activeRuns, stalledRuns } from "./benchmarkActivity";
import { onMovingAlias, rowKey } from "./benchmarkBoards";

/** Model navigation is independent of every execution setting. */
export function modelKey(configuration: Configuration): string {
  return JSON.stringify([
    configuration.providerId,
    configuration.modelId,
    ...(onMovingAlias(configuration) ? [configuration.modelName ?? null] : []),
  ]);
}

export interface LeaderboardModel {
  key: string;
  /** Scores calculated from the model's test cells by the native service. */
  row: LeaderboardRow;
  configurations: LeaderboardRow[];
}

/** Prefer coverage, then recency, never the highest score or cheapest run. */
function coverageOrder(a: LeaderboardRow, b: LeaderboardRow): number {
  return (
    (b.complete ?? b.scored) - (a.complete ?? a.scored) ||
    b.scored - a.scored ||
    (b.measuredAt ?? 0) - (a.measuredAt ?? 0) ||
    rowKey(a).localeCompare(rowKey(b))
  );
}

/** Keep execution evidence separate while displaying each model once. */
export function leaderboardModels(rows: LeaderboardRow[]): LeaderboardModel[] {
  const groups = new Map<string, LeaderboardRow[]>();
  for (const row of rows) {
    const key = modelKey(row.configuration);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([key, entries]) => {
    const configurations = [...entries].sort(coverageOrder);
    return { key, row: configurations[0], configurations };
  });
}

/** The service owns aggregation; the UI never averages configuration scores. */
export function reportModels(
  report: LeaderboardReport | undefined,
): LeaderboardModel[] {
  if (!report) return [];
  if (!report.models?.length) return leaderboardModels(report.rows);
  const byKey = new Map(report.rows.map((row) => [rowKey(row), row]));
  return report.models.flatMap((model) => {
    const row = model.row;
    if (!row) return [];
    const configurations = model.configurationKeys.flatMap((key) => {
      const entry = byKey.get(key);
      return entry ? [entry] : [];
    });
    return [{ key: model.key, row, configurations }];
  });
}

/** Activity from any configuration belongs to the model's single row. */
export function modelActivity(model: LeaderboardModel, runs: RunSummary[]) {
  let open = 0;
  let running = 0;
  let newest: RunSummary | null = null;
  for (const run of activeRuns(runs)) {
    const ids = new Set(
      run.request.configurations
        .filter((entry) => modelKey(entry) === model.key)
        .map((entry) => entry.id),
    );
    for (const cell of run.openCells ?? []) {
      if (!ids.has(cell.configurationId)) continue;
      open += 1;
      if (cell.running) running += 1;
      if (!newest || run.createdAt > newest.createdAt) newest = run;
    }
  }
  return {
    open,
    running,
    runId: newest?.id ?? null,
    attention: stalledRuns(runs)
      .filter((run) =>
        run.request.configurations.some(
          (entry) => modelKey(entry) === model.key,
        ),
      )
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}
