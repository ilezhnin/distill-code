/**
 * "The conductor changed something itself" — the Q6 badge.
 *
 * The conductor is prompt-only: `CONDUCTOR_PROTOCOL_PROMPT` tells it to plan or
 * to answer and never to execute. It is nonetheless an ordinary session with an
 * ordinary toolset, so the instruction can leak; the operator decision (Q6) was
 * to make a leak *visible* rather than to enforce it at the harness.
 *
 * Every step a conductor takes is on screen, named for a person, so the badge
 * is not what makes its work visible. It is the one warning that the work
 * changed something, and it is only worth reading if it is right. It used to
 * fire on anything it could not prove was a lookup: an investigative turn of
 * `python -c` checks, PowerShell pipelines and project status scripts was
 * badged turn after turn, and a warning on every turn is a warning nobody
 * reads. So it fires on evidence of a change instead:
 *
 * - a tool whose kind is a change — `edit`, `delete`, `move` (Claude Code's
 *   Edit and Write arrive as `edit`);
 * - a shell command that visibly writes — a redirect into a file, `rm`, `mv`,
 *   `sed -i`, `git commit`, `npm install`, `Set-Content`, and the rest of
 *   `isWritingShellCommand` (`shared/lib/shellCommandReading.ts`).
 *
 * A script that may or may not write is shown as the step it is, without the
 * badge — the same way the open harnesses show a command they ran.
 *
 * Visible still means cheap and read-only: a predicate over the content of one
 * turn. No store, no bookkeeping, nothing persisted — a changing tool call in
 * a conductor's assistant message *is* the leak, and the badge is derived from
 * it wherever that message is rendered.
 */

import {
  isWritingShellCommand,
  toolCallCommandText,
} from "@/shared/lib/shellCommandReading";
import type {
  MessageContent,
  ToolKind,
  ToolRequestContent,
} from "@/shared/types/messages";

/** Tool kinds that are a change by definition. */
const CHANGING_TOOL_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>([
  "edit",
  "delete",
  "move",
]);

/**
 * True when this tool call visibly changes something: its kind is a change,
 * or it is a shell command that writes.
 */
export function isChangingToolCall(block: ToolRequestContent): boolean {
  if (block.toolKind && CHANGING_TOOL_KINDS.has(block.toolKind)) return true;
  if (block.toolKind !== "execute") return false;
  const command = toolCallCommandText(block.arguments);
  return command !== null && isWritingShellCommand(command);
}

/**
 * True when this assistant turn ran a tool that changed something.
 *
 * The caller supplies the "is this a conductor" half. Legacy orchestrator
 * shells share that flag in the transcript context but can never match here:
 * they are short-circuited in `sendCore` and never reach a model at all, so
 * they have no tool calls to find.
 */
export function turnHasChangingToolCall(
  content: readonly MessageContent[] | undefined,
): boolean {
  return Boolean(
    content?.some(
      (block) => block.type === "toolRequest" && isChangingToolCall(block),
    ),
  );
}
