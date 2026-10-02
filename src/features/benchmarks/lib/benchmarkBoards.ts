// One leaderboard, several boards: every measurement ranks on its own axis
// instead of being folded into one score with hidden weights.
import type { LeaderboardCohort, LeaderboardRow } from "../types";

export const CLASS_BOARD_PREFIX = "class:";

export type BoardId =
  | "overall"
  | "efficiency"
  | "speed"
  | "cost"
  | `${typeof CLASS_BOARD_PREFIX}${string}`;

export interface Board {
  id: BoardId;
  /** Work class id for a class board; null for the shared measurements. */
  workClass: string | null;
  higherIsBetter: boolean;
  value: (row: LeaderboardRow) => number | null;
}

export function boardsFor(
  cohort: LeaderboardCohort | null | undefined,
): Board[] {
  return [
    {
      id: "overall",
      workClass: null,
      higherIsBetter: true,
      value: (row) => row.quality,
    },
    ...(cohort?.workClasses ?? []).map(
      (workClass): Board => ({
        id: `${CLASS_BOARD_PREFIX}${workClass}`,
        workClass,
        higherIsBetter: true,
        value: (row) =>
          row.axes.find((axis) => axis.id === workClass)?.quality ?? null,
      }),
    ),
    {
      id: "efficiency",
      workClass: null,
      higherIsBetter: false,
      value: (row) => row.medianOutputTokens,
    },
    {
      id: "speed",
      workClass: null,
      higherIsBetter: false,
      value: (row) => row.medianDurationMs,
    },
    {
      id: "cost",
      workClass: null,
      higherIsBetter: false,
      value: (row) => row.cost,
    },
  ];
}

export interface RankedRow {
  row: LeaderboardRow;
  value: number | null;
  /** 1-based; tied values share a rank and the next rank skips. Null when unranked. */
  rank: number | null;
  /** 0–100 share of the best ranked value; null without a value or a ranked best. */
  share: number | null;
}

export function rowKey(row: LeaderboardRow): string {
  return JSON.stringify(row.configuration);
}

/** Share of the best value: the leader fills the bar on every board. */
export function shareOfBest(
  value: number,
  best: number,
  higherIsBetter: boolean,
): number {
  const ratio = higherIsBetter
    ? best <= 0
      ? 0
      : value / best
    : value <= 0
      ? 1
      : best / value;
  return Math.max(0, Math.min(100, 100 * ratio));
}

/**
 * Only comparable rows receive a rank; incomplete and excluded rows keep their
 * values but sink below the ranked rows in their original order.
 */
export function rankRows(rows: LeaderboardRow[], board: Board): RankedRow[] {
  const entries = rows.map((row) => ({ row, value: board.value(row) }));
  const ranked = entries
    .filter(
      (entry): entry is { row: LeaderboardRow; value: number } =>
        entry.row.status === "comparable" && entry.value != null,
    )
    .sort((a, b) =>
      board.higherIsBetter ? b.value - a.value : a.value - b.value,
    );
  const best = ranked[0]?.value;
  const rest = entries.filter((entry) => !ranked.includes(entry as never));
  let rank = 0;
  return [
    ...ranked.map((entry, index) => {
      if (index === 0 || entry.value !== ranked[index - 1].value)
        rank = index + 1;
      return {
        ...entry,
        rank,
        share: shareOfBest(entry.value, best as number, board.higherIsBetter),
      };
    }),
    ...rest.map((entry) => ({
      ...entry,
      rank: null,
      share:
        best == null || entry.value == null
          ? null
          : shareOfBest(entry.value, best, board.higherIsBetter),
    })),
  ];
}
