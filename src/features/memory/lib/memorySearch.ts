import {
  memoryRecency,
  type ArchivedMemoryEntry,
  type MemoryEntry,
} from "./memoryEntry";

/**
 * Finding a fact the prompt no longer carries (P32).
 *
 * The prompt block is budgeted and recency-ordered, which is right for a
 * block that has to fit in every message and wrong as the only way to reach a
 * memory. "What did we decide about the release branch?" is a question about
 * something that may have been decided in another project, three hundred
 * memories ago, and pushed out of the block long before it stopped being true.
 * The store still holds it. This is what gets it back.
 *
 * Deliberately not an index. Three hundred short strings is a scan that costs
 * nothing at the size this store is capped at, and an index would be a second
 * structure to keep in step with a list that is edited by hand, by agents, and
 * by a cap that evicts from the front.
 *
 * Ranking has one rule worth stating: a memory that matches every word of the
 * question outranks a more recent one that matches some of them. Recency
 * decides which memories are *shown by default*; when the operator has typed a
 * question, how well the answer fits it is the better signal.
 *
 * The archive is searched only when the caller passes it, and its hits are
 * marked. A memory displaced by the cap is still the operator's and must be
 * findable, but a line the app stopped standing behind should not be handed
 * back as if it were current — so at equal rank the live one comes first.
 */

export interface MemorySearchHit {
  entry: MemoryEntry;
  /** Terms of the query this entry actually contains. */
  matched: string[];
  /** True when the entry contains the query as one phrase. */
  phrase: boolean;
  /** True when the hit came from the archive. Absent for a live memory. */
  archived?: boolean;
}

/** Words a query is split into, lowercased, punctuation stripped. */
export function memorySearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}._/-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * Every memory matching the query, best first.
 *
 * A query with no usable words matches nothing rather than everything: an
 * empty search box should show the list the page already shows, and that is
 * the caller's decision, not a result set of three hundred rows.
 */
export function searchMemories(
  entries: readonly MemoryEntry[],
  query: string,
  options: {
    limit?: number;
    archived?: readonly ArchivedMemoryEntry[];
  } = {},
): MemorySearchHit[] {
  const terms = memorySearchTerms(query);
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();

  const hits: MemorySearchHit[] = [];
  const collect = (list: readonly MemoryEntry[], archived: boolean) => {
    for (const entry of list) {
      const haystack = entry.text.toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term));
      if (matched.length === 0) continue;
      hits.push({
        entry,
        matched,
        phrase: phrase.length > 0 && haystack.includes(phrase),
        ...(archived ? { archived: true } : {}),
      });
    }
  };
  collect(entries, false);
  if (options.archived) collect(options.archived, true);

  hits.sort((left, right) => {
    if (left.phrase !== right.phrase) return left.phrase ? -1 : 1;
    if (left.matched.length !== right.matched.length) {
      return right.matched.length - left.matched.length;
    }
    if (Boolean(left.archived) !== Boolean(right.archived)) {
      return left.archived ? 1 : -1;
    }
    return memoryRecency(right.entry) - memoryRecency(left.entry);
  });

  return typeof options.limit === "number"
    ? hits.slice(0, options.limit)
    : hits;
}
