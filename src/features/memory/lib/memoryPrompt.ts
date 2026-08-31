/**
 * What the session is told it already knows.
 *
 * One block, global facts first, this project's after — the same order every
 * turn, because the block sits at the head of a cached prompt and reshuffling
 * it would cost a cache miss on every send for no gain.
 *
 * The block is omitted entirely when there is nothing to say. An empty
 * `<memory>` section reads to a model as "this operator has told me nothing",
 * which is worse than silence: it invites the model to fill it.
 */

import {
  appliesToProject,
  entriesForProject,
  memoryRecency,
  type ArchivedMemoryEntry,
  type MemoryEntry,
} from "./memoryEntry";
import { MEMORY_PROTOCOL_PROMPT } from "./memoryFence";
import { MEMORY_RECALL_PROMPT, RECALL_FENCE_TAG } from "./memoryRecall";

/**
 * Ceiling on how much remembered text one prompt carries.
 *
 * Memory competes with the actual work for context. Past this, the oldest
 * entries are left out of the prompt — they stay stored and visible in
 * settings, they simply stop being repeated to the model.
 */
export const MAX_MEMORY_PROMPT_CHARS = 4000;

function withinBudget(entries: MemoryEntry[]): MemoryEntry[] {
  let used = 0;
  const kept: MemoryEntry[] = [];
  // Most recently useful first while measuring, then restored to the stable
  // order. Recency, not age: a fact the agents keep restating is the live one
  // even if it was first written down months ago, and it is the stale ones
  // nobody has touched since that should fall out of a full prompt.
  const byRecency = [...entries].sort(
    (left, right) => memoryRecency(right) - memoryRecency(left),
  );
  for (const entry of byRecency) {
    const cost = entry.text.length + 3;
    if (used + cost > MAX_MEMORY_PROMPT_CHARS) break;
    used += cost;
    kept.push(entry);
  }
  const keptIds = new Set(kept.map((entry) => entry.id));
  return entries.filter((entry) => keptIds.has(entry.id));
}

/**
 * How many archived memories this session is allowed to be told about.
 *
 * Counted through the same project gate the entries themselves pass: another
 * project's archive is none of this session's business, and even the number
 * of them is a fact about work it cannot see.
 */
export function archivedCountForProject(
  archived: readonly ArchivedMemoryEntry[],
  projectId: string | null,
): number {
  return archived.filter((entry) => appliesToProject(entry, projectId)).length;
}

/**
 * The block, plus — when there is more behind it — one line saying so.
 *
 * A budget the model cannot see is a budget it reads as the whole truth: the
 * store may hold three hundred memories and the block twenty, and the model
 * answers "you never told me" in perfect good faith. The count is the pointer
 * to the recall fence, and it goes last, after the entries: the block heads a
 * cached prompt, and a line inserted anywhere earlier would move every line
 * below it and cost a cache miss on every send.
 */
export function formatMemoryPrompt(
  entries: readonly MemoryEntry[],
  archivedCount: number,
  projectId: string | null,
): string | undefined {
  const reachable = entriesForProject(entries, projectId);
  const relevant = withinBudget(reachable);
  if (relevant.length === 0) return undefined;
  const stored = Math.max(0, archivedCount);
  const beyond = reachable.length - relevant.length + stored;
  return [
    "<memory>",
    "Facts the operator has kept from earlier sessions. Treat them as true unless this conversation shows otherwise — and when it does, say so and correct the record with the protocol below.",
    "",
    ...relevant.map((entry) => `- ${entry.text}`),
    ...(beyond > 0
      ? [
          `…and ${beyond} older memories are stored beyond this block (${stored} archived). Ask with the ${RECALL_FENCE_TAG} fence.`,
        ]
      : []),
    "</memory>",
  ].join("\n");
}

/**
 * The memory half of a session's system prompt: what is remembered, how to
 * ask for the rest, and — when this session may write — how to add to it.
 *
 * For a writing session the write protocol always ships: an agent with
 * nothing remembered yet is exactly the one that needs to know it can start.
 * A session the memory ACL keeps read-only (a worker node, an orchestrator
 * without the `memory_write` grant) gets the facts without it — teaching it a
 * fence the scanner would refuse is worse than silence, because the model
 * would keep "remembering" things into a void.
 *
 * Recall is the other way round: it is a read, and reading is what every
 * session carrying the block already does, so a read-only session is taught
 * it too. It ships with the block and not without one — a session that was
 * told nothing is remembered has nothing to ask about, and the block is where
 * the count of what it is missing lives.
 */
export function composeMemorySection(
  entries: readonly MemoryEntry[],
  archivedCount: number,
  projectId: string | null,
  writeAllowed: boolean,
): string | undefined {
  const remembered = formatMemoryPrompt(entries, archivedCount, projectId);
  if (!remembered) return writeAllowed ? MEMORY_PROTOCOL_PROMPT : undefined;
  return [
    remembered,
    ...(writeAllowed ? [MEMORY_PROTOCOL_PROMPT] : []),
    MEMORY_RECALL_PROMPT,
  ].join("\n\n");
}
