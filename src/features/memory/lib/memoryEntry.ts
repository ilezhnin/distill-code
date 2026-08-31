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

/**
 * Why a memory left the live list.
 *
 * `capacity` is the store's own bound pushing out the least recently useful
 * line; `forgotten` is an agent retiring a statement through the fence;
 * `superseded` is the same fence replacing it with a corrected one.
 */
export const MEMORY_ARCHIVE_REASONS = [
  "capacity",
  "forgotten",
  "superseded",
] as const;

export type MemoryArchiveReason = (typeof MEMORY_ARCHIVE_REASONS)[number];

/** True for a stored value that names one of the reasons above. */
export function isMemoryArchiveReason(
  value: unknown,
): value is MemoryArchiveReason {
  return (MEMORY_ARCHIVE_REASONS as readonly unknown[]).includes(value);
}

/**
 * A memory that left the live list but was not destroyed.
 *
 * Displacement is not deletion: the operator's record is theirs, and the app
 * may only stop putting a line in the prompt, never decide the line is gone
 * (LAWS/MEMORY.md, Sovereignty). Everything the entry was is kept as it was,
 * plus when it was displaced and what displaced it.
 */
export interface ArchivedMemoryEntry extends MemoryEntry {
  archivedAt: number;
  archiveReason: MemoryArchiveReason;
  /** Set when a correction replaced this entry in the same fence. */
  replacedById?: string;
}

/**
 * The size past which the archive is too big to be useful.
 *
 * A line the panel says out loud, not one the app enforces by throwing
 * memories away. It used to be the second: past this the oldest displacements
 * were dropped, which is the app deleting a memory with no operator behind
 * it, and the law allows no such exception (LAWS/MEMORY.md, Sovereignty). The
 * pressure the bound answered is real — the archive is read back by a scan
 * and mirrored into every project folder — so it stays, visible, and the
 * clearing out becomes the operator's, on rows they can read and choose.
 */
export const MAX_ARCHIVED_ENTRIES = 2000;

/** True once the archive is past its bound and wants the operator's broom. */
export function isArchiveOverfull(archivedCount: number): boolean {
  return archivedCount > MAX_ARCHIVED_ENTRIES;
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
