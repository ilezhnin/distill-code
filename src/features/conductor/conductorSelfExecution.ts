/**
 * "The conductor is doing the work itself" — the Q6 badge.
 *
 * The conductor is prompt-only: `CONDUCTOR_PROTOCOL_PROMPT` tells it to plan or
 * to answer and never to execute. It is nonetheless an ordinary session with an
 * ordinary toolset, so the instruction can leak; the operator decision (Q6) was
 * to make a leak *visible* rather than to enforce it at the harness, and to
 * revisit only if it turns out to happen for real.
 *
 * It happened for real — in the other direction. Live waves showed the badge
 * crying wolf: a conductor that greps a file to answer a question, or reads a
 * report before planning, is doing exactly what the protocol wants, and a
 * warning on every such turn teaches the operator to ignore the warning. So
 * the badge is tiered by the ACP tool kind: reading is quiet, *changing
 * something* is the leak. A tool whose kind is unknown counts as changing
 * something, because a warning that fires needlessly costs attention while a
 * mutation that passes silently costs trust in the whole surface.
 *
 * Visible still means cheap and read-only: a predicate over the content of one
 * turn. No store, no bookkeeping, nothing persisted — a mutating tool call in a
 * conductor's assistant message *is* the leak, and the badge is derived from it
 * wherever that message is rendered.
 */

import type { MessageContent, ToolKind } from "@/shared/types/messages";

/**
 * Tool kinds that only look at the world.
 *
 * `read`, `search` and `fetch` are self-evident; `think` runs no tool at all;
 * `switch_mode` reconfigures the session rather than touching the workspace.
 * Everything else — `edit`, `delete`, `move`, `execute`, `other` — either
 * changes state or (`execute`, `other`) can, and gets the badge.
 */
const READ_ONLY_TOOL_KINDS: ReadonlySet<ToolKind> = new Set([
  "read",
  "search",
  "think",
  "fetch",
  "switch_mode",
]);

/**
 * True when this tool kind can change state.
 *
 * `undefined` is mutating on purpose: a harness that reports no kind gives us
 * nothing to be lenient on, and the pre-tiering behaviour — badge every tool
 * call — is the right fallback there.
 */
export function isMutatingToolKind(kind: ToolKind | undefined): boolean {
  return kind === undefined || !READ_ONLY_TOOL_KINDS.has(kind);
}

/**
 * True when this assistant turn ran a tool that can change state.
 *
 * The caller supplies the "is this a conductor" half. Legacy orchestrator
 * shells share that flag in the transcript context but can never match here:
 * they are short-circuited in `sendCore` and never reach a model at all, so
 * they have no tool calls to find.
 */
export function turnHasMutatingToolCall(
  content: readonly MessageContent[] | undefined,
): boolean {
  return Boolean(
    content?.some(
      (block) =>
        block.type === "toolRequest" && isMutatingToolKind(block.toolKind),
    ),
  );
}
