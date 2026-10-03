import type { HistorySnapshot } from "../hooks/useBenchmarks";
import { configurationKey } from "./benchmarkBoards";

/** Select the recalculated series or the immutable dated evidence. */
export function historyMeasurements(
  snapshots: HistorySnapshot[],
  key: string,
  recorded = false,
) {
  let previous: string | null = null;
  let gap = 0;
  return snapshots.flatMap((snapshot) => {
    const report = recorded
      ? snapshot.report
      : (snapshot.recalculatedReport ?? snapshot.report);
    const row = report.rows.find(
      (r) => configurationKey(r.configuration) === key,
    );
    if (!row || row.points == null) {
      gap += 1;
      previous = null;
      return [];
    }
    const versions = [...row.scoredVersionIds].sort();
    const series = JSON.stringify([
      versions,
      row.comparisonKey ?? row.configuration.inventoryRevision,
      gap,
    ]);
    const signature = JSON.stringify([
      series,
      [...row.attemptIds].sort(),
      row.points,
      row.cost,
      recorded ? [] : snapshot.backfilledVersionIds,
    ]);
    // A run of another model or an unmeasured case is not a new observation.
    if (signature === previous) return [];
    previous = signature;
    return [{ snapshot, report, row, series }];
  });
}
