/**
 * "The conductor is doing the work itself" — the Q6 badge.
 *
 * The conductor is prompt-only: `CONDUCTOR_PROTOCOL_PROMPT` tells it to plan or
 * to answer and never to execute. It is nonetheless an ordinary session with an
 * ordinary toolset, so the instruction can leak; the operator decision (Q6) was
 * to make a leak *visible* rather than to enforce it at the harness, and to
 * revisit only if it turns out to happen for real.
 *
 * Visible means cheap and read-only: a predicate over the content of one turn.
 * No store, no bookkeeping, nothing persisted — a tool call in a conductor's
 * assistant message *is* the leak, and the badge is derived from it wherever
 * that message is rendered.
 */

import type { MessageContent } from "@/shared/types/messages";

/**
 * True when this assistant turn contains a tool call.
 *
 * The caller supplies the "is this a conductor" half. Legacy orchestrator
 * shells share that flag in the transcript context but can never match here:
 * they are short-circuited in `sendCore` and never reach a model at all, so
 * they have no tool calls to find.
 */
export function turnHasToolCall(
  content: readonly MessageContent[] | undefined,
): boolean {
  return Boolean(content?.some((block) => block.type === "toolRequest"));
}
