// One leaderboard, several boards. The service scores every board on the same
// scale (points out of 1000, see analysis.rs), so the operator and the selector
// read identical numbers; this module only orders and labels them.
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
  /** Points out of 1000 on this board. */
  points: (row: LeaderboardRow) => number | null;
}

export function boardsFor(
  cohort: LeaderboardCohort | null | undefined,
): Board[] {
  return [
    { id: "overall", workClass: null, points: (row) => row.points },
    ...(cohort?.workClasses ?? []).map(
      (workClass): Board => ({
        id: `${CLASS_BOARD_PREFIX}${workClass}`,
        workClass,
        points: (row) =>
          row.axes.find((axis) => axis.id === workClass)?.points ?? null,
      }),
    ),
    {
      id: "efficiency",
      workClass: null,
      points: (row) => row.efficiencyPoints,
    },
    { id: "speed", workClass: null, points: (row) => row.speedPoints },
    { id: "cost", workClass: null, points: (row) => row.costPoints },
  ];
}

export interface RankedRow {
  row: LeaderboardRow;
  points: number | null;
  /** 1-based; tied points share a rank and the next rank skips. Null when unranked. */
  rank: number | null;
  /** 0–100 bar length: points over ten. */
  share: number | null;
}

export function rowKey(row: LeaderboardRow): string {
  return JSON.stringify(row.configuration);
}

/**
 * Only comparable rows receive a rank; incomplete and excluded rows keep their
 * points but sink below the ranked rows in their original order.
 */
export function rankRows(rows: LeaderboardRow[], board: Board): RankedRow[] {
  const entries = rows.map((row) => ({ row, points: board.points(row) }));
  const ranked = entries
    .filter(
      (entry): entry is { row: LeaderboardRow; points: number } =>
        entry.row.status === "comparable" && entry.points != null,
    )
    .sort((a, b) => b.points - a.points);
  const rest = entries.filter((entry) => !ranked.includes(entry as never));
  let rank = 0;
  return [
    ...ranked.map((entry, index) => {
      if (index === 0 || entry.points !== ranked[index - 1].points)
        rank = index + 1;
      return { ...entry, rank, share: entry.points / 10 };
    }),
    ...rest.map((entry) => ({
      ...entry,
      rank: null,
      share: entry.points == null ? null : entry.points / 10,
    })),
  ];
}
