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

/**
 * Which memories one session's block actually carries, and what they cost.
 *
 * The same answer the prompt builder needs and the settings panel needs: a
 * line in the list is not a line in the block, and the operator who cannot
 * see the difference concludes the agent ignored what they wrote down. Two
 * copies of this arithmetic would drift, and the copy that drifts is the one
 * shown to the operator — so there is one, and the prompt is built from it.
 */
export function selectPromptEntries(
  entries: readonly MemoryEntry[],
  projectId: string | null,
): { ids: Set<string>; usedChars: number } {
  let usedChars = 0;
  const ids = new Set<string>();
  // Most recently useful first while measuring; the caller restores the
  // stable order. Recency, not age: a fact the agents keep restating is the
  // live one even if it was first written down months ago, and it is the
  // stale ones nobody has touched since that should fall out of a full prompt.
  const byRecency = [...entriesForProject(entries, projectId)].sort(
    (left, right) => memoryRecency(right) - memoryRecency(left),
  );
  for (const entry of byRecency) {
    const cost = entry.text.length + 3;
    if (usedChars + cost > MAX_MEMORY_PROMPT_CHARS) break;
    usedChars += cost;
    ids.add(entry.id);
  }
  return { ids, usedChars };
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
  const { ids } = selectPromptEntries(entries, projectId);
  const relevant = reachable.filter((entry) => ids.has(entry.id));
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
