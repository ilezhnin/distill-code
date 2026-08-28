import { useChatStore } from "@/features/chat/stores/chatStore";

import { isWorkingStatus } from "./brigadeActivity";
import { useConductorGraphStore } from "./conductorGraphStore";
import { stopOrchestratorSession } from "./orchestratorControls";
import type { NodeBudget, SessionNode } from "./types";

/**
 * The brake on a running agent (P49).
 *
 * Until this existed, a wave's only limit was the operator noticing. A step
 * that started looping — re-reading the same file, retrying the same failing
 * command, arguing with itself — cost whatever it cost, and the operator found
 * out afterwards, from the bill. Everything else in the engine is about
 * whether the work is *right*; this is the only thing that is about whether it
 * is still worth paying for.
 *
 * The ceiling is a ceiling however it is expressed: dollars when the provider
 * prices its tokens, tokens when it does not, and the wall clock for the case
 * neither catches — an agent stuck waiting on something that will never come
 * spends no tokens at all while it burns the afternoon.
 *
 * Exhaustion is not a failure. The agent is stopped, its node says what it ran
 * out of, and the wave's own machinery treats it exactly as it treats any
 * other stopped step: it is digested, reported and judged. An operator who
 * disagrees raises the budget and asks again, which is a decision they get to
 * make with the numbers in front of them.
 */

export type BudgetLimit = "usd" | "tokens" | "minutes";

export interface BudgetSpend {
  usd?: number;
  tokens?: number;
  minutes?: number;
}

export interface BudgetBreach {
  sessionId: string;
  limit: BudgetLimit;
  /** The ceiling the node carried. */
  allowed: number;
  /** What it had actually spent when the check ran. */
  spent: number;
}

/**
 * Which limit, if any, this spend has passed.
 *
 * Checked in the order money, tokens, time — the order the operator cares
 * about — so a run that broke two ceilings at once is reported by the one
 * that costs them something. A limit with nothing measured against it is not
 * a breach: an unpriced provider reports no cost, and treating "we cannot see
 * the money" as "no money was spent" is the mistake that would make a dollar
 * ceiling silently useless.
 */
export function firstBreachedLimit(
  budget: NodeBudget | undefined,
  spend: BudgetSpend,
): { limit: BudgetLimit; allowed: number; spent: number } | null {
  if (!budget) return null;
  for (const limit of ["usd", "tokens", "minutes"] as const) {
    const allowed = budget[limit];
    const spent = spend[limit];
    if (typeof allowed !== "number" || typeof spent !== "number") continue;
    if (spent >= allowed) return { limit, allowed, spent };
  }
  return null;
}

/** What one node has spent, from the chat store's own accounting. */
export function spendForNode(
  node: SessionNode,
  tokenState:
    | { accumulatedTotal: number; accumulatedCost?: number | null }
    | undefined,
  now: number,
): BudgetSpend {
  const spend: BudgetSpend = {};
  if (typeof tokenState?.accumulatedCost === "number") {
    spend.usd = tokenState.accumulatedCost;
  }
  if (typeof tokenState?.accumulatedTotal === "number") {
    spend.tokens = tokenState.accumulatedTotal;
  }
  if (typeof node.createdAt === "number") {
    spend.minutes = (now - node.createdAt) / 60_000;
  }
  return spend;
}

/**
 * Every working agent that has passed one of its own ceilings.
 *
 * Pure, so the decision can be tested without a store or a clock. The caller
 * supplies both.
 */
export function breachedBudgets(
  nodesById: Record<string, SessionNode>,
  tokenStateOf: (
    sessionId: string,
  ) =>
    | { accumulatedTotal: number; accumulatedCost?: number | null }
    | undefined,
  now: number,
): BudgetBreach[] {
  const breaches: BudgetBreach[] = [];
  for (const key in nodesById) {
    const node = nodesById[key];
    if (!node || node.sessionId !== key) continue;
    if (!node.budget || !isWorkingStatus(node.status)) continue;
    const breach = firstBreachedLimit(
      node.budget,
      spendForNode(node, tokenStateOf(node.sessionId), now),
    );
    if (breach) breaches.push({ sessionId: node.sessionId, ...breach });
  }
  return breaches;
}

/**
 * Stops whatever has run out, once per node.
 *
 * Called from the wave engine's tick, which already runs on every graph and
 * chat change, so no timer of its own. The `stopped` mark is written before
 * the cancel is awaited: the tick can fire again while the cancel is in
 * flight, and stopping the same session twice would send two cancels and
 * write two notices for one event.
 */
export function enforceBudgets(now: number = Date.now()): BudgetBreach[] {
  const graph = useConductorGraphStore.getState();
  const chat = useChatStore.getState();
  const breaches = breachedBudgets(
    graph.nodesById,
    (sessionId) => chat.sessionStateById[sessionId]?.tokenState,
    now,
  );
  for (const breach of breaches) {
    graph.patchNode(breach.sessionId, {
      status: "stopped",
      task: describeBreach(breach, graph.getNode(breach.sessionId)?.task),
    });
    void stopOrchestratorSession(breach.sessionId);
  }
  return breaches;
}

/**
 * The node's task line, with the reason it stopped appended.
 *
 * On the node rather than only in a notice because this is the answer to
 * "why is this executor stopped?", and the operator asks that question from
 * the chip they are looking at, not from a message further up the transcript.
 */
export function describeBreach(
  breach: BudgetBreach,
  task: string | undefined,
): string {
  const spent =
    breach.limit === "usd"
      ? `$${breach.spent.toFixed(2)} of $${breach.allowed.toFixed(2)}`
      : breach.limit === "tokens"
        ? `${Math.round(breach.spent)} of ${Math.round(breach.allowed)} tokens`
        : `${breach.spent.toFixed(1)} of ${breach.allowed} minutes`;
  const reason = `Stopped: it reached its budget (${spent}).`;
  return task ? `${task}\n${reason}` : reason;
}
