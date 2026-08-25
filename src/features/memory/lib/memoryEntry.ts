/**
 * What the agents are allowed to remember, and how it is kept.
 *
 * A memory is one short statement the operator wants to hold across sessions —
 * "the release branch is `release/2026.9`", "Ivan reviews Rust changes himself".
 * Not a transcript, not a summary: the value of a memory is that it is short
 * enough to sit in every system prompt without crowding out the work.
 *
 * Two scopes only. `global` follows the operator everywhere; `project` belongs
 * to one project and is invisible outside it — a fact about one codebase
 * leaking into every other chat is worse than not remembering it at all.
 *
 * Pure. Storage is `memoryStore`; the prompt is `memoryPrompt`.
 */

export type MemoryScope = "global" | "project";

export interface MemoryEntry {
  id: string;
  /** One statement, trimmed and single-line. */
  text: string;
  scope: MemoryScope;
  /** Set when the scope is `project`; null for a global memory. */
  projectId: string | null;
  createdAt: number;
  /** Who wrote it. An agent memory names the session it came from. */
  createdBySessionId?: string;
  /** Last time an agent asked to remember this same statement again. */
  reinforcedAt?: number;
}

/** Longest statement kept. Longer ones are cut rather than dropped. */
export const MAX_MEMORY_TEXT = 280;

/**
 * Normalizes a statement to the one shape memory stores.
 *
 * Newlines collapse: a memory is a line in a list, and one that carries its
 * own paragraph breaks turns the prompt block into a document.
 */
export function normalizeMemoryText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_MEMORY_TEXT
    ? `${collapsed.slice(0, MAX_MEMORY_TEXT - 1).trimEnd()}…`
    : collapsed;
}

/** Two statements are the same memory when they read the same. */
export function sameMemoryText(left: string, right: string): boolean {
  return (
    normalizeMemoryText(left).toLowerCase() ===
    normalizeMemoryText(right).toLowerCase()
  );
}

/**
 * When a memory was last useful: reinforced if an agent has restated it,
 * otherwise when it was written.
 *
 * Recency, not age, is what should decide which memories keep their place in
 * a full prompt and which fall out of a full store — a fact the agents keep
 * confirming is the live one, however long ago it was first written down.
 */
export function memoryRecency(entry: MemoryEntry): number {
  return entry.reinforcedAt ?? entry.createdAt;
}

/** True when this entry applies to the given project (global always does). */
export function appliesToProject(
  entry: MemoryEntry,
  projectId: string | null,
): boolean {
  if (entry.scope === "global") return true;
  return entry.projectId !== null && entry.projectId === projectId;
}

/**
 * The entries one session should be told about: global first, then this
 * project's, each oldest first so the block is stable between turns. A block
 * that reshuffles itself invalidates the provider's prompt cache on every
 * send for no benefit at all.
 */
export function entriesForProject(
  entries: readonly MemoryEntry[],
  projectId: string | null,
): MemoryEntry[] {
  const byAge = (left: MemoryEntry, right: MemoryEntry) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id);
  return [
    ...entries.filter((entry) => entry.scope === "global").sort(byAge),
    ...entries
      .filter(
        (entry) =>
          entry.scope === "project" && appliesToProject(entry, projectId),
      )
      .sort(byAge),
  ];
}
