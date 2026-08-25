/**
 * What finished while the operator was away.
 *
 * Work that runs unattended has one failure mode that outranks all the
 * others: it finishes and nobody notices. A wave parked on `needsOperator`
 * is waiting for a person who does not know they are being waited for, and
 * a failed step reads as silence from whichever tab it happened in. The only
 * way to see either today is to open every conductor chat in turn.
 *
 * This is the summary that replaces that. One row per conductor, not per
 * agent: a five-step wave is one piece of work the operator thinks about,
 * and five rows saying "finished" would bury the one saying "stuck".
 *
 * Pure. `nowMs` and `lastSeenAt` are arguments for the same reason the
 * planner's are: a summary that reads the wall clock cannot be tested.
 */

import type {
  RunStatus,
  SessionNode,
  StructuredReport,
} from "@/features/conductor/types";

export type ReviewOutcome = "needsOperator" | "failed" | "completed";

export interface ReviewItem {
  /** Conductor session to open. */
  sessionId: string;
  displayName: string;
  /** The most serious thing that happened, which is what the row leads with. */
  outcome: ReviewOutcome;
  completed: number;
  failed: number;
  /** How many of this conductor's finished agents asked for a person. */
  needsOperator: number;
  /** Newest finish among the counted agents. */
  latestAt: number;
  /** Newest report's own words, when there is one. */
  summary?: string;
}

/** A terminal run status: the node is finished and will not change again. */
function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "stopped"
  );
}

/**
 * Which conductor a finished agent belongs to.
 *
 * `rootConductorId` is the whole point of the field — a worker under an
 * orchestrator under a conductor still belongs to that conductor, and the
 * operator opens the conductor, not the middle.
 */
function conductorOf(node: SessionNode): string | null {
  return node.rootConductorId ?? node.parentSessionId;
}

function rank(outcome: ReviewOutcome): number {
  return outcome === "needsOperator" ? 0 : outcome === "failed" ? 1 : 2;
}

export interface ReviewQueueInput {
  nodes: Iterable<SessionNode>;
  reportOf: (runId: string) => StructuredReport | undefined;
  /** Epoch ms of the last time the operator looked at this list. */
  lastSeenAt: number;
}

/**
 * The rows to show, most urgent first, then most recent.
 *
 * Only agents that finished *after* `lastSeenAt` are counted: this is a
 * queue of news, and a conductor whose work the operator has already read
 * should not keep reappearing at the top of it. A node with no `finishedAt`
 * predates that stamp and is treated as already seen rather than as new —
 * a migration should not announce a month of old runs as if they just landed.
 */
export function buildReviewQueue(input: ReviewQueueInput): ReviewItem[] {
  const byConductor = new Map<string, ReviewItem>();

  for (const node of input.nodes) {
    if (node.role !== "orchestrator" && node.role !== "worker") continue;
    if (!isTerminal(node.status)) continue;
    const finishedAt = node.finishedAt;
    if (finishedAt === undefined || finishedAt <= input.lastSeenAt) continue;
    const sessionId = conductorOf(node);
    if (!sessionId) continue;

    const report = node.runId ? input.reportOf(node.runId) : undefined;
    const failed =
      node.status === "failed" ||
      node.status === "cancelled" ||
      report?.status === "failed";
    const needsOperator = report?.needsOperator === true;

    const existing = byConductor.get(sessionId);
    const item: ReviewItem = existing ?? {
      sessionId,
      displayName: "",
      outcome: "completed",
      completed: 0,
      failed: 0,
      needsOperator: 0,
      latestAt: 0,
    };

    if (needsOperator) item.needsOperator += 1;
    if (failed) item.failed += 1;
    else item.completed += 1;

    item.outcome =
      item.needsOperator > 0
        ? "needsOperator"
        : item.failed > 0
          ? "failed"
          : "completed";

    // The newest finish owns the row's timestamp and its words: what the
    // operator wants first is the latest state of this conductor's work.
    if (finishedAt >= item.latestAt) {
      item.latestAt = finishedAt;
      const summary = report?.summary?.trim();
      if (summary) item.summary = summary;
    }
    byConductor.set(sessionId, item);
  }

  const named = [...byConductor.values()];
  return named.sort(
    (left, right) =>
      rank(left.outcome) - rank(right.outcome) ||
      right.latestAt - left.latestAt,
  );
}

/**
 * Fills in each row's conductor name.
 *
 * Separate from the build because the names live in the session store and
 * the build is pure over the graph. A conductor whose session is gone keeps
 * its fallback rather than dropping the row: the work still happened, and a
 * row the operator cannot open still tells them it did.
 */
export function withConductorNames(
  items: readonly ReviewItem[],
  nameOf: (sessionId: string) => string | undefined,
  fallback: string,
): ReviewItem[] {
  return items.map((item) => ({
    ...item,
    displayName: nameOf(item.sessionId)?.trim() || fallback,
  }));
}
