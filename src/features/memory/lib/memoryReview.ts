/**
 * The memory review: the whole record, handed to a chat that can correct it.
 *
 * An exact duplicate the store catches by itself. Twins — "the release branch
 * is release/2026.9" against "release branch: now 2026.9" — and outright
 * contradictions accumulate silently, and nothing in the app is placed to
 * notice: a session is shown the prompt block, never the list, and the list is
 * the only place the two lines sit next to each other.
 *
 * So the review is one deliberate pass the operator starts. The panel composes
 * the live record into a message, an ordinary chat is opened with it, and the
 * model proposes. It applies nothing until the operator says so, and what it
 * then applies goes through the same `distill-memory` fence every other agent
 * writes with — no second protocol, no silent edit.
 *
 * The dump carries the statements and their dates and nothing else: no ids, no
 * session the line came from, no project id. A secret never reaches it because
 * a secret never reaches the store (`memoryRememberRefusal`), and the way to
 * keep that true here is to print only what the operator can already read on
 * the page.
 *
 * `composeReviewMessage` is pure; `startMemoryReviewChat` is the one impure
 * line, and it reuses the berdctl surface rather than a private path.
 */

import type { MemoryEntry } from "./memoryEntry";

/**
 * How much of the record one review message carries.
 *
 * `berdctl session create` refuses a prompt over 50 000 characters, and a full
 * store (300 lines of up to 280 characters) can pass that. Cutting the dump and
 * saying how many lines were cut is the honest end of it: the alternative is a
 * button that works until the operator's memory gets interesting and then
 * fails.
 */
export const MAX_REVIEW_DUMP_CHARS = 40_000;

/** Names the area a memory belongs to; `null` is the everywhere group. */
export type MemoryProjectNameResolver = (projectId: string | null) => string;

interface ReviewGroup {
  title: string;
  entries: MemoryEntry[];
}

/**
 * What the review chat is asked to do, and in what order.
 *
 * Model-facing, so English and not translated — the same choice
 * `MEMORY_PROTOCOL_PROMPT` makes. Proposal first and application second is the
 * whole point of the pass: a consolidation that edits while it reasons is a
 * silent rewrite of the operator's record, which is exactly what the panel
 * exists to prevent.
 */
const REVIEW_INSTRUCTION = [
  "This is a review of the memories you carry between sessions. Everything currently remembered is listed below.",
  "",
  "First propose, as a list and nothing more:",
  "",
  "1. Duplicates and near-duplicates — which lines say the same thing, and the one wording they should become.",
  "2. Contradictions — which lines disagree, and which of them is the live fact.",
  "3. Stale — what is no longer true and should be dropped.",
  "4. Too long, or carrying more than one fact — how to split it.",
  "",
  "Apply nothing yet. Wait for my explicit confirmation, line by line.",
  "",
  "Once I confirm, apply what I confirmed with `distill-memory` fences: the old wording under `forget` and the new one under `remember`, in the same block, at most 5 per reply. Do not restate a secret in any form. Anything I did not confirm, leave exactly as it is.",
  "",
  "This chat belongs to no project, so a fence sent from it can only change the memories that apply everywhere. Propose the project-scoped ones here too, but they have to be applied from a chat inside that project.",
].join("\n");

/** ISO day, so the dates read the same whatever locale the panel is in. */
function reviewDate(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime())
    ? "unknown"
    : date.toISOString().slice(0, 10);
}

/**
 * One line: the statement, quoted so the model can copy it into a `forget`
 * verbatim, then when it was written down and when an agent last confirmed it.
 * A memory with no date behind it reads as timeless, and "is this still true"
 * is the question the whole pass is asking.
 */
function reviewLine(entry: MemoryEntry): string {
  const kept = `kept ${reviewDate(entry.createdAt)}`;
  return entry.reinforcedAt
    ? `- "${entry.text}" (${kept}, confirmed ${reviewDate(entry.reinforcedAt)})`
    : `- "${entry.text}" (${kept})`;
}

/**
 * The record in the order the panel shows it: everywhere first, then one
 * heading per project in the order their memories appear, newest line first
 * inside each. The operator reads the dump against the page, so the two agree.
 */
function reviewGroups(
  entries: readonly MemoryEntry[],
  projectNameOf: MemoryProjectNameResolver,
): ReviewGroup[] {
  const newestFirst = (left: MemoryEntry, right: MemoryEntry) =>
    right.createdAt - left.createdAt;
  const groups: ReviewGroup[] = [];
  const global = entries.filter((entry) => entry.scope === "global");
  if (global.length > 0) {
    groups.push({
      title: projectNameOf(null),
      entries: [...global].sort(newestFirst),
    });
  }
  const projectIds = [
    ...new Set(
      entries
        .filter((entry) => entry.scope === "project" && entry.projectId)
        .map((entry) => entry.projectId as string),
    ),
  ];
  for (const projectId of projectIds) {
    groups.push({
      title: projectNameOf(projectId),
      entries: entries
        .filter((entry) => entry.projectId === projectId)
        .sort(newestFirst),
    });
  }
  return groups;
}

/**
 * The message the review chat opens with: the instruction, then the record.
 *
 * `archivedCount` is said rather than dumped. The archive is what the app has
 * already stopped carrying, so it is not what a consolidation acts on — but a
 * model told nothing about it would read the live list as everything the
 * operator ever kept, and propose "remembering" lines that were retired on
 * purpose.
 */
export function composeReviewMessage(
  entries: readonly MemoryEntry[],
  archivedCount: number,
  projectNameOf: MemoryProjectNameResolver,
): string {
  const sections: string[] = [REVIEW_INSTRUCTION];
  let used = 0;
  let omitted = 0;
  for (const group of reviewGroups(entries, projectNameOf)) {
    const lines: string[] = [];
    for (const entry of group.entries) {
      const line = reviewLine(entry);
      if (used + line.length > MAX_REVIEW_DUMP_CHARS) {
        omitted += 1;
        continue;
      }
      used += line.length;
      lines.push(line);
    }
    if (lines.length === 0) continue;
    sections.push([`## ${group.title}`, ...lines].join("\n"));
  }
  if (sections.length === 1) {
    sections.push("Nothing is remembered yet — there is nothing to review.");
  }
  if (omitted > 0) {
    sections.push(
      `${omitted} more live ${omitted === 1 ? "memory is" : "memories are"} kept but left out of this list to keep it readable. Ask for them with the \`distill-recall\` fence.`,
    );
  }
  const archived = Math.max(0, archivedCount);
  if (archived > 0) {
    sections.push(
      `${archived} ${archived === 1 ? "memory is" : "memories are"} archived and not listed here. Archived lines are already out of every prompt; do not propose bringing one back unless I ask.`,
    );
  }
  return sections.join("\n\n");
}

/** The berdctl registry call, injectable so tests do not need the registry. */
export type MemoryReviewDispatch = (
  name: string,
  rawArgs: unknown,
  ctx: Record<string, never>,
) => Promise<unknown>;

const dispatchThroughRegistry: MemoryReviewDispatch = async (...args) => {
  const { dispatchCommand } = await import(
    "@/features/berdctl/commands/registry"
  );
  return dispatchCommand(...args);
};

/**
 * Opens the review chat: create a projectless session carrying the message,
 * then bring the operator to it.
 *
 * The same two commands the app already exposes for "start a chat with this in
 * it" and "put that chat on screen" — the path `openSessionDeepLink` takes into
 * an existing chat, one action along. No project is named on purpose: a review
 * ranges over every area, and a chat inside one project would be shown that
 * project's memories and none of the others (LAWS/MEMORY.md, Reading back).
 */
export async function startMemoryReviewChat(
  message: string,
  dispatch: MemoryReviewDispatch = dispatchThroughRegistry,
): Promise<string> {
  const created = await dispatch(
    "sessions",
    { action: "create", prompt: message },
    {},
  );
  const sessionId = (created as { session_id?: unknown } | null)?.session_id;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("session create returned no session id");
  }
  await dispatch("sessions", { action: "open", session_id: sessionId }, {});
  return sessionId;
}
