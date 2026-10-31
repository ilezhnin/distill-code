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
 * The tiering by kind was half the fix. ACP's `execute` means "running commands
 * or code" — `git log`, `cat` and `rg` carry the same kind as `rm`, and on a
 * harness whose only way to look at a repository is a shell the badge went back
 * to firing on every investigative turn. So an `execute` call is read a second
 * time, by its command: a command this module can parse and finds to be
 * read-only stays quiet (`shared/lib/shellCommandReading.ts`), and everything
 * else — unparseable, unknown, or genuinely writing — keeps the badge. The asymmetry is deliberate. Missing a
 * read costs a needless warning; missing a write costs the trust the badge
 * exists to hold, so the parser bails towards "mutating" at every ambiguity.
 *
 * Visible still means cheap and read-only: a predicate over the content of one
 * turn. No store, no bookkeeping, nothing persisted — a mutating tool call in a
 * conductor's assistant message *is* the leak, and the badge is derived from it
 * wherever that message is rendered.
 */

import {
  isReadOnlyShellCommand,
  toolCallCommandText,
} from "@/shared/lib/shellCommandReading";
import type {
  MessageContent,
  ToolKind,
  ToolRequestContent,
} from "@/shared/types/messages";

/**
 * Tool kinds that only look at the world.
 *
 * `read`, `search` and `fetch` are self-evident; `think` runs no tool at all;
 * `switch_mode` reconfigures the session rather than touching the workspace.
 * Everything else — `edit`, `delete`, `move`, `execute`, `other` — either
 * changes state or (`execute`, `other`) can, and gets the badge.
 *
 * `list` is not an ACP kind at all, which is why the set is typed over
 * strings: the grok bridge reports its `list_dir` tool as `"kind":"list"`, the
 * cast in the notification handler lets any string through, and a directory
 * listing branded as a mutation is the cry-wolf badge back under another name.
 * The same bridge then says `other` on every `tool_call_update`; the handler
 * refuses that downgrade (`toolCallUpdatePatchFor`), which is what keeps
 * `list` in the stored block for this predicate to read.
 */
const READ_ONLY_TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind | "list">([
  "read",
  "search",
  "think",
  "fetch",
  "switch_mode",
  "list",
]);

/**
 * True when this tool kind can change state.
 *
 * `undefined` is mutating on purpose: a harness that reports no kind gives us
 * nothing to be lenient on, and the pre-tiering behaviour — badge every tool
 * call — is the right fallback there.
 *
 * This is the kind tier alone. `execute` is mutating here and is given its
 * second reading by {@link isMutatingToolCall}, which is what callers with a
 * whole tool call in hand should use.
 */
export function isMutatingToolKind(kind: ToolKind | undefined): boolean {
  return kind === undefined || !READ_ONLY_TOOL_KINDS.has(kind);
}

/**
 * True when this tool call can change state.
 *
 * The kind decides, except for `execute`, where the command decides — that is
 * the kind a shell arrives under whether it is reading or writing.
 */
export function isMutatingToolCall(block: ToolRequestContent): boolean {
  if (block.toolKind === "execute") {
    const command = toolCallCommandText(block.arguments);
    return command === null || !isReadOnlyShellCommand(command);
  }
  return isMutatingToolKind(block.toolKind);
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
      (block) => block.type === "toolRequest" && isMutatingToolCall(block),
    ),
  );
}
