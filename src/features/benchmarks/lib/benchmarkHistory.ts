import type { HistorySnapshot } from "../hooks/useBenchmarks";
import { configurationKey } from "./benchmarkBoards";

/** Preserve partial observations without turning changes in coverage into a trend. */
export function historyMeasurements(snapshots: HistorySnapshot[], key: string) {
  let previous: string | null = null;
  let gap = 0;
  return snapshots.flatMap((snapshot) => {
    const row = snapshot.report.rows.find(
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
      row.configuration.inventoryRevision,
      gap,
    ]);
    const signature = JSON.stringify([
      series,
      [...row.attemptIds].sort(),
      row.points,
    ]);
    // A run of another model or an unmeasured case is not a new observation.
    if (signature === previous) return [];
    previous = signature;
    return [{ snapshot, row, series }];
  });
}
