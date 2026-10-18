import type { HistorySnapshot } from "../hooks/useBenchmarks";
import { configurationKey } from "./benchmarkBoards";
import { reportModels } from "./benchmarkModels";

/** Select the recalculated series or the immutable dated evidence. */
export function historyMeasurements(
  snapshots: HistorySnapshot[],
  key: string,
  recorded = false,
  model = false,
) {
  let previous: string | null = null;
  let measuredBefore: Set<string> | null = null;
  let gap = 0;
  return snapshots.flatMap((snapshot) => {
    const report = recorded
      ? snapshot.report
      : (snapshot.recalculatedReport ?? snapshot.report);
    const row = model
      ? reportModels(report).find((entry) => entry.key === key)?.row
      : report.rows.find((r) => configurationKey(r.configuration) === key);
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
    // The cases this point measured that the previous point did not, and
    // the reverse: a changed case set is why two points stay unjoined.
    const before = measuredBefore;
    const measured = new Set(versions);
    const change = before && {
      added: versions.filter((id) => !before.has(id)).length,
      removed: [...before].filter((id) => !measured.has(id)).length,
    };
    measuredBefore = measured;
    return [{ snapshot, report, row, series, change }];
  });
}
