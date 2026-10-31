/**
 * How an agent's work reads to the person watching it.
 *
 * The transcript keeps every step, but a person skims: the open coding
 * harnesses fold consecutive lookups — reading files, searching, listing
 * folders — into one line ("Explored · 3 files read, 2 searches"), keep a
 * command that does something on a line of its own, and show reasoning as a
 * one-line heading rather than as paragraphs. These are the pure halves of
 * that: which steps are lookups, and what a thought is about.
 */

import {
  type ShellLookupKind,
  shellLookupKind,
  toolCallCommandText,
} from "@/shared/lib/shellCommandReading";
import type {
  MessageContent,
  ToolRequestContent,
} from "@/shared/types/messages";

export type LookupKind = ShellLookupKind;

/**
 * What kind of lookup this tool call is, or `null` when it does something.
 *
 * The bridge's kind decides for its own tools (Claude's Read, Grep and Glob
 * arrive as `read` and `search`; Grok's directory listing as `list`). A shell
 * call is a lookup only when its command is provably read-only — the same
 * reading the conductor's self-execution badge relies on — and the command
 * decides which kind.
 */
export function toolLookupKind(
  request: ToolRequestContent | undefined,
): LookupKind | null {
  if (!request) return null;
  const kind: string | undefined = request.toolKind;
  if (kind === "read") return "read";
  if (kind === "search") return "search";
  if (kind === "list") return "list";
  if (kind !== "execute") return null;
  const command = toolCallCommandText(request.arguments);
  return command ? shellLookupKind(command) : null;
}

const HEADLINE_MAX_LENGTH = 120;

/**
 * A thought's heading: its first line, without Markdown heading or bold marks.
 *
 * Reasoning summaries usually open with a bold line that names the step
 * ("**Checking the cache builder**"), which is the part a person scans for.
 */
export function thoughtHeadline(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  const plain = line
    .replace(/^#+\s*/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .trim();
  return plain.length > HEADLINE_MAX_LENGTH
    ? `${plain.slice(0, HEADLINE_MAX_LENGTH - 1).trimEnd()}…`
    : plain;
}

/** What a running turn is doing right now, as its status line names it. */
export type LiveActivity =
  | { kind: "tool"; request: ToolRequestContent }
  | { kind: "thought"; headline: string };

/**
 * The step a running turn is on: the tool call still in flight, otherwise the
 * heading of its latest thought — or `null` once the agent is writing its
 * answer, or before it has done anything worth naming.
 *
 * Read from the turn's own content, newest first, and never past the agent's
 * latest text: what came before that is history, not what it is doing.
 */
export function liveActivity(
  content: readonly MessageContent[] | undefined,
): LiveActivity | null {
  if (!content) return null;
  const answered = new Set(
    content.flatMap((block) =>
      block.type === "toolResponse" ? [block.id] : [],
    ),
  );
  let thought: string | null = null;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block) continue;
    if (block.type === "text" && block.text.trim()) break;
    if (
      block.type === "toolRequest" &&
      !answered.has(block.id) &&
      (block.status === "pending" || block.status === "in_progress")
    ) {
      return { kind: "tool", request: block };
    }
    if (
      thought === null &&
      (block.type === "thinking" || block.type === "reasoning")
    ) {
      thought = thoughtHeadline(block.text) || null;
    }
  }
  return thought ? { kind: "thought", headline: thought } : null;
}
