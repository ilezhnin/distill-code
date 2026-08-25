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
  entriesForProject,
  memoryRecency,
  type MemoryEntry,
} from "./memoryEntry";
import { MEMORY_PROTOCOL_PROMPT } from "./memoryFence";

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

export function formatMemoryPrompt(
  entries: readonly MemoryEntry[],
  projectId: string | null,
): string | undefined {
  const relevant = withinBudget(entriesForProject(entries, projectId));
  if (relevant.length === 0) return undefined;
  return [
    "<memory>",
    "Facts the operator has kept from earlier sessions. Treat them as true unless this conversation shows otherwise — and when it does, say so and correct the record with the protocol below.",
    "",
    ...relevant.map((entry) => `- ${entry.text}`),
    "</memory>",
  ].join("\n");
}

/**
 * The memory half of a session's system prompt: what is remembered, plus how
 * to add to it. The protocol always ships — an agent with nothing remembered
 * yet is exactly the one that needs to know it can start.
 */
export function composeMemorySection(
  entries: readonly MemoryEntry[],
  projectId: string | null,
): string {
  const remembered = formatMemoryPrompt(entries, projectId);
  return remembered
    ? `${remembered}\n\n${MEMORY_PROTOCOL_PROMPT}`
    : MEMORY_PROTOCOL_PROMPT;
}
