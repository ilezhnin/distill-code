/**
 * Where remembered facts live.
 *
 * A JSON document in the operator's Distill folder, beside their projects and
 * sessions. It began in `localStorage` for want of a way to write a file, and
 * that was the wrong home for the one thing in the app that is supposed to
 * outlive everything: memory that a backup cannot see and a reinstall erases
 * is not memory. An old browser copy is migrated on first read, then removed.
 *
 * Reading salvages rather than validates. The store starts empty and is
 * filled by `hydrateMemoryStore`; nothing is written back before that read
 * lands, because an empty list persisted over a full one during startup would
 * quietly forget everything.
 */

import { create } from "zustand";

import { distillDocument } from "@/shared/lib/distillDocument";

import { useProjectStore } from "@/features/projects/stores/projectStore";

import type {
  MemoryFenceRemember,
  MemoryFenceRequest,
} from "../lib/memoryFence";
import { findSecret, type SecretKind } from "../lib/memoryRedaction";
import {
  mergeProjectMemories,
  readProjectMemories,
  writeProjectMemories,
} from "../lib/projectMemoryDocuments";
import {
  isMemoryArchiveReason,
  memoryRecency,
  normalizeMemoryText,
  sameMemoryText,
  type ArchivedMemoryEntry,
  type MemoryEntry,
  type MemoryScope,
} from "../lib/memoryEntry";

/** Path under the Distill root. */
export const MEMORY_DOCUMENT_PATH = "memory.json";

/** Where memory lived before the move; read once, then removed. */
export const MEMORY_STORAGE_KEY = "goose:memory";

/** Upper bound on stored memories. Oldest go first. */
export const MAX_MEMORY_ENTRIES = 300;

/** Bound on the "already read this message" tombstones. */
export const MAX_APPLIED_MEMORY_MESSAGE_IDS = 2000;

interface MemoryState {
  entries: MemoryEntry[];
  /** Displaced memories, kept because the app may not destroy one. */
  archived: ArchivedMemoryEntry[];
  appliedMessageIds: string[];
  /**
   * Messages whose `distill-recall` question has already been answered.
   *
   * Kept beside the write side's tombstones, and for the same reason: the
   * scanner re-reads the tail on every store change, and one question must
   * cost the session one answer, not one per keystroke of the next reply.
   */
  recallAnsweredMessageIds: string[];
  /** False until the stored document has been read. Writes wait for it. */
  hydrated: boolean;
}

export interface MemoryDraft {
  text: string;
  scope: MemoryScope;
  projectId?: string | null;
  createdBySessionId?: string;
}

interface MemoryActions {
  remember: (draft: MemoryDraft, nowMs?: number) => string;
  /**
   * Rewrites one live memory, or says why it was not rewritten.
   *
   * An edit is a write, and it goes through the same verdict `remember` does:
   * the field on a row was the one door into the store that asked nothing, so
   * a token pasted over an existing line was kept, carried into every later
   * prompt and mirrored into the project folder (LAWS/MEMORY.md, Writing).
   * The verdict is returned rather than swallowed because a refusal the row
   * cannot show is the app losing an action the operator took.
   */
  updateEntry: (id: string, text: string) => MemoryRefusal | null;
  forget: (id: string) => void;
  /**
   * Puts an archived memory back in the live list.
   *
   * The operator overruling a displacement, so the line comes back as itself
   * — same id, same date, same provenance — rather than as a new memory
   * written today. Overflow is left to the cap, which is the only thing that
   * knows what is now the least useful line.
   *
   * Refused, out loud, when the line carries a secret: the archive has
   * entrances `remember` never saw — a document written by an older build, a
   * project folder copied from another machine — and restoring is what would
   * put such a line back into every prompt.
   */
  restoreArchived: (id: string, nowMs?: number) => MemoryRefusal | null;
  /** The operator destroying an archived memory. No copy is left. */
  deleteArchived: (id: string) => void;
  /**
   * Everything one project ever taught the app, live and archived.
   *
   * The panel's sweep for a project that no longer exists. It is a store
   * action rather than a filter in the page because the archive is half of
   * what the operator is deleting and the page cannot see all of it: rows
   * left behind here are unreachable by recall, invisible in the panel, and
   * still travel into every backup — which is not what "this cannot be
   * undone" promised.
   */
  forgetProject: (projectId: string) => void;
  /**
   * Applies one agent message's `distill-memory` block, once.
   *
   * `projectId` scopes everything the message asks to keep at project level;
   * a message sent from a session with no project can only keep global facts,
   * because a project memory with no project is a memory nothing will ever
   * read back.
   *
   * A correction is applied whole or not at all: when the store refuses
   * `remember[i]`, the `forget[i]` paired with it is left unapplied, so a
   * refused replacement costs the operator nothing rather than the fact.
   */
  applyAgentRequest: (
    messageId: string,
    sessionId: string,
    projectId: string | null,
    request: MemoryFenceRequest,
    nowMs?: number,
  ) => { remembered: number; forgotten: number };
  /**
   * Records a message's fence as handled without applying any of it.
   *
   * For fences the memory ACL refuses (a worker's, an ungranted
   * orchestrator's): the tombstone is what stops the scanner from
   * re-reporting the same refusal on every store change, and writing it
   * *instead of* the entries is the refusal.
   */
  dismissAgentRequest: (messageId: string) => void;
  /**
   * Records that a message's recall question has been dealt with.
   *
   * Written before the answer is delivered, not after: delivery is async and
   * goes through the session queue, and a second pass that ran in between
   * would ask the same question again.
   */
  markRecallAnswered: (messageId: string) => void;
  /**
   * Swaps the live list wholesale, leaving the archive as it is.
   *
   * For a caller that is replacing what is remembered rather than deleting
   * it. Removing a set of memories is `forgetProject` or `forget`, both of
   * which reach the archive too — a sweep written as a filter here leaves the
   * archived halves behind.
   */
  replaceAll: (entries: MemoryEntry[]) => void;
}

export type MemoryStore = MemoryState & MemoryActions;

function parseEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<MemoryEntry>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const text =
    typeof raw.text === "string" ? normalizeMemoryText(raw.text) : "";
  if (!text) return null;
  const scope: MemoryScope = raw.scope === "global" ? "global" : "project";
  const projectId =
    scope === "project" && typeof raw.projectId === "string" && raw.projectId
      ? raw.projectId
      : null;
  // A project memory that lost its project can never match a session again.
  if (scope === "project" && projectId === null) return null;
  return {
    id: raw.id,
    text,
    scope,
    projectId,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    ...(typeof raw.createdBySessionId === "string"
      ? { createdBySessionId: raw.createdBySessionId }
      : {}),
    ...(typeof raw.reinforcedAt === "number"
      ? { reinforcedAt: raw.reinforcedAt }
      : {}),
  };
}

export function parseMemoryEntries(value: unknown): MemoryEntry[] {
  const list = Array.isArray(value)
    ? value
    : ((value as { entries?: unknown })?.entries ?? null);
  if (!Array.isArray(list)) return [];
  return list
    .map(parseEntry)
    .filter((entry): entry is MemoryEntry => entry !== null);
}

/**
 * An archived row, read the same salvaging way a live one is.
 *
 * A row whose reason is missing or unknown is read as `capacity` rather than
 * dropped: why a memory was displaced is worth less than the memory itself,
 * and a document written by a newer build must not cost the operator lines.
 */
function parseArchivedEntry(value: unknown): ArchivedMemoryEntry | null {
  const entry = parseEntry(value);
  if (!entry) return null;
  const raw = value as Partial<ArchivedMemoryEntry>;
  return {
    ...entry,
    archivedAt: typeof raw.archivedAt === "number" ? raw.archivedAt : 0,
    archiveReason: isMemoryArchiveReason(raw.archiveReason)
      ? raw.archiveReason
      : "capacity",
    ...(typeof raw.replacedById === "string" && raw.replacedById
      ? { replacedById: raw.replacedById }
      : {}),
  };
}

/** The archive of a stored document. A v1 document simply has none. */
export function parseArchivedMemoryEntries(
  value: unknown,
): ArchivedMemoryEntry[] {
  const list = Array.isArray(value)
    ? value
    : ((value as { archived?: unknown })?.archived ?? null);
  if (!Array.isArray(list)) return [];
  return list
    .map(parseArchivedEntry)
    .filter((entry): entry is ArchivedMemoryEntry => entry !== null);
}

function parseMessageIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    )
    .slice(-MAX_APPLIED_MEMORY_MESSAGE_IDS);
}

export function parseAppliedMemoryMessageIds(value: unknown): string[] {
  return parseMessageIds(
    (value as { appliedMessageIds?: unknown })?.appliedMessageIds,
  );
}

/** The answered-recall tombstones. A v1 document has none, which is empty. */
export function parseRecallAnsweredMessageIds(value: unknown): string[] {
  return parseMessageIds(
    (value as { recallAnsweredMessageIds?: unknown })?.recallAnsweredMessageIds,
  );
}

/**
 * Trims to the bound, least recently useful first, and says what it took.
 *
 * By recency rather than age: a standing fact the agents keep restating is
 * the one worth the space, and evicting it because it was written first would
 * throw away exactly what memory is for. What changed is not which memory
 * leaves the list but where it goes — `evicted` is what the caller archives,
 * because a memory displaced by a bound must not be destroyed.
 */
export function capWithArchive(entries: MemoryEntry[]): {
  kept: MemoryEntry[];
  evicted: MemoryEntry[];
} {
  if (entries.length <= MAX_MEMORY_ENTRIES)
    return { kept: entries, evicted: [] };
  const keep = new Set(
    [...entries]
      .sort((left, right) => memoryRecency(right) - memoryRecency(left))
      .slice(0, MAX_MEMORY_ENTRIES)
      .map((entry) => entry.id),
  );
  const kept: MemoryEntry[] = [];
  const evicted: MemoryEntry[] = [];
  for (const entry of entries) {
    if (keep.has(entry.id)) kept.push(entry);
    else evicted.push(entry);
  }
  return { kept, evicted };
}

/**
 * The archive with capacity-displaced entries folded in. Nothing leaves.
 *
 * The archive used to be trimmed here, oldest displacement first, and that
 * was the app deleting a memory on nobody's instruction — which the law
 * allows no exception for (LAWS/MEMORY.md, Sovereignty). The pressure the
 * trim answered is real: the archive is written to disk and mirrored into
 * every project folder. So `MAX_ARCHIVED_ENTRIES` stayed and stopped being a
 * knife — past it the panel asks the operator to clear the archive out, on
 * rows they can read and choose between, and the app keeps holding all of it
 * until they do.
 */
function withCapacityEvictions(
  archived: ArchivedMemoryEntry[],
  evicted: readonly MemoryEntry[],
  nowMs: number,
): ArchivedMemoryEntry[] {
  if (evicted.length === 0) return archived;
  return [
    ...archived,
    ...evicted.map((entry) => ({
      ...entry,
      archivedAt: nowMs,
      archiveReason: "capacity" as const,
    })),
  ];
}

function commit(
  entries: MemoryEntry[],
  archived: ArchivedMemoryEntry[],
  appliedMessageIds: string[],
  recallAnsweredMessageIds: string[],
  nowMs: number = Date.now(),
): MemoryState {
  const { kept, evicted } = capWithArchive(entries);
  const next: MemoryState = {
    entries: kept,
    archived: withCapacityEvictions(archived, evicted, nowMs),
    appliedMessageIds: appliedMessageIds.slice(-MAX_APPLIED_MEMORY_MESSAGE_IDS),
    recallAnsweredMessageIds: recallAnsweredMessageIds.slice(
      -MAX_APPLIED_MEMORY_MESSAGE_IDS,
    ),
    hydrated: true,
  };
  if (useMemoryStore.getState().hydrated) {
    document.write(next);
    // And a copy into each project's own folder, so a project carries what
    // was learned about it when it moves (P31). Fire-and-forget: the global
    // document is the one that must not fail, and a folder that cannot be
    // written costs that project's mirror and nothing else.
    queueProjectMemoryMirror(next.entries, next.archived);
  }
  return next;
}

/**
 * Mirrors project memories into their folders, coalesced.
 *
 * A `distill-memory` fence can remember several facts in one message, and the
 * store commits once per fact; writing every project's file that many times
 * would be a burst of disk writes for one logical change. One timer, the same
 * debounce the global document uses.
 */
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorPending: {
  entries: MemoryEntry[];
  archived: ArchivedMemoryEntry[];
} | null = null;

function queueProjectMemoryMirror(
  entries: MemoryEntry[],
  archived: ArchivedMemoryEntry[],
): void {
  mirrorPending = { entries, archived };
  if (mirrorTimer !== null) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    void flushProjectMemoryMirror();
  }, PROJECT_MEMORY_MIRROR_DEBOUNCE_MS);
}

/** Test seam and shutdown: pushes a queued mirror without waiting for it. */
export async function flushProjectMemoryMirror(): Promise<void> {
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
  const pending = mirrorPending;
  mirrorPending = null;
  if (!pending) return;
  await writeProjectMemories(
    useProjectStore.getState().projects,
    pending.entries,
    pending.archived,
  );
}

const PROJECT_MEMORY_MIRROR_DEBOUNCE_MS = 250;

function stateFromDocument(parsed: unknown): MemoryState {
  // A document written over a larger bound is capped on the way in, and the
  // overflow is archived here too: reading a file is not an operator action.
  const { kept, evicted } = capWithArchive(parseMemoryEntries(parsed));
  return {
    entries: kept,
    archived: withCapacityEvictions(
      parseArchivedMemoryEntries(parsed),
      evicted,
      Date.now(),
    ),
    appliedMessageIds: parseAppliedMemoryMessageIds(parsed),
    recallAnsweredMessageIds: parseRecallAnsweredMessageIds(parsed),
    hydrated: true,
  };
}

const document = distillDocument<MemoryState>({
  path: MEMORY_DOCUMENT_PATH,
  legacyStorageKey: MEMORY_STORAGE_KEY,
  parse: stateFromDocument,
  // v2 adds `archived` and the answered-recall tombstones. A v1 document
  // reads back whole: it simply has neither, which is the same thing as two
  // empty lists.
  serialize: (state) => ({
    version: 2,
    entries: state.entries,
    archived: state.archived,
    appliedMessageIds: state.appliedMessageIds,
    recallAnsweredMessageIds: state.recallAnsweredMessageIds,
  }),
});

/** Fills the store from disk. Called once at startup; a second call is a no-op. */
export async function hydrateMemoryStore(): Promise<void> {
  if (useMemoryStore.getState().hydrated) return;
  const stored = await document.read();
  const base = stored ?? {
    entries: [],
    archived: [],
    appliedMessageIds: [],
    recallAnsweredMessageIds: [],
    hydrated: true,
  };
  // Then whatever the project folders themselves know (P31). A project copied
  // from another machine arrives with its memories in it, and this is where
  // they join the list; entries already in memory win, so nothing the
  // operator has edited in this session is reverted by a copy on disk.
  let entries = base.entries;
  let archived = base.archived;
  try {
    const fromFolders = await readProjectMemories(
      useProjectStore.getState().projects,
      parseMemoryEntries,
      parseArchivedMemoryEntries,
    );
    const capped = capWithArchive(
      mergeProjectMemories(base.entries, fromFolders.entries),
    );
    entries = capped.kept;
    archived = withCapacityEvictions(
      mergeProjectMemories(base.archived, fromFolders.archived),
      capped.evicted,
      Date.now(),
    );
  } catch (error) {
    console.error("Failed to read project memories:", error);
  }
  useMemoryStore.setState({ ...base, entries, archived, hydrated: true });
}

/** Waits for a queued write to land. For tests and for shutdown. */
export function flushMemoryWrites(): Promise<void> {
  return Promise.all([document.flush(), flushProjectMemoryMirror()]).then(
    () => undefined,
  );
}

function newMemoryId(): string {
  return `mem_${crypto.randomUUID()}`;
}

/**
 * Finds an entry the given statement would duplicate, inside its own scope.
 *
 * Scope-exact on purpose. A global line reads the same way in a project's
 * block, but it is not the row the operator asked for: treating it as one
 * meant that picking a project in the selector and pressing Remember only
 * reinforced the global entry and added nothing, so the panel looked as if
 * the click had never happened (checklist C.3). The reverse is left alone —
 * widening a fact to everywhere writes the global row and does not touch the
 * project row, because removing a line the operator can see is theirs to do.
 */
function existingMatch(
  entries: readonly MemoryEntry[],
  text: string,
  scope: MemoryScope,
  projectId: string | null,
): MemoryEntry | undefined {
  return entries.find(
    (entry) =>
      sameMemoryText(entry.text, text) &&
      entry.scope === scope &&
      (scope === "global" || entry.projectId === projectId),
  );
}

/**
 * Why a statement an agent asked to keep was not kept.
 *
 * Named rather than boolean because the sync says the refusal out loud, and
 * "nothing was kept" tells the operator nothing about what to do next. The
 * shape of a secret is the only thing that may be spoken about one — never
 * the value, never the statement.
 */
export type MemoryRefusal =
  | { reason: "secret"; shape: SecretKind }
  | { reason: "no-project" }
  | { reason: "blank" };

/**
 * The store's verdict on one `remember` item, before anything is written.
 *
 * Decided ahead of the write and exported so the sync can report the same
 * verdict it acts on: a refusal the app makes twice, in two places, drifts.
 * Secrets come first, so a statement that is both a secret and unscopeable
 * is refused for the reason that matters.
 */
export function memoryRememberRefusal(
  item: MemoryFenceRemember,
  projectId: string | null,
): MemoryRefusal | null {
  const shape = findSecret(item.text);
  if (shape) return { reason: "secret", shape };
  // A session with no project cannot keep a project fact; keeping it globally
  // instead would be the app inventing a scope nobody asked for.
  if (item.scope === "project" && !projectId) return { reason: "no-project" };
  if (!normalizeMemoryText(item.text)) return { reason: "blank" };
  return null;
}

/**
 * The archived lines that exist only because this live one replaced them.
 *
 * Follows `replacedById` back through the chain, so a statement corrected
 * three times names all three of its earlier wordings. They are not separate
 * memories the operator kept: they are older drafts of the one line the panel
 * shows, and the panel shows exactly one row and offers exactly one "forget"
 * for them (G2/F3). Leaving them behind made that button a half-truth — the
 * row vanished, and the next recall answer handed the old wording straight
 * back to the agent, marked `archived`.
 */
export function supersededChain(
  archived: readonly ArchivedMemoryEntry[],
  id: string,
): Set<string> {
  const chain = new Set<string>();
  let frontier = new Set([id]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const entry of archived) {
      if (chain.has(entry.id)) continue;
      if (entry.replacedById && frontier.has(entry.replacedById)) {
        chain.add(entry.id);
        next.add(entry.id);
      }
    }
    frontier = next;
  }
  return chain;
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  entries: [],
  archived: [],
  appliedMessageIds: [],
  recallAnsweredMessageIds: [],
  hydrated: false,

  remember: (draft, nowMs = Date.now()) => {
    const projectId =
      draft.scope === "project" ? (draft.projectId ?? null) : null;
    // One verdict, asked here and reported by the panel and the sync from the
    // same function: this path had grown its own copy of the checks, and the
    // copies had already drifted in what they look at first. Refusal, not
    // repair — the caller is told nothing was kept, and no edited version of
    // a refused statement is stored in its place (LAWS/MEMORY.md, Writing).
    if (
      memoryRememberRefusal({ text: draft.text, scope: draft.scope }, projectId)
    )
      return "";
    const text = normalizeMemoryText(draft.text);
    const state = get();
    const duplicate = existingMatch(
      state.entries,
      text,
      draft.scope,
      projectId,
    );
    if (duplicate) {
      // Saying it again is not a second memory; it is the same one, restated.
      set(() =>
        commit(
          state.entries.map((entry) =>
            entry.id === duplicate.id
              ? { ...entry, reinforcedAt: nowMs }
              : entry,
          ),
          state.archived,
          state.appliedMessageIds,
          state.recallAnsweredMessageIds,
          nowMs,
        ),
      );
      return duplicate.id;
    }
    const id = newMemoryId();
    set(() =>
      commit(
        [
          ...state.entries,
          {
            id,
            text,
            scope: draft.scope,
            projectId,
            createdAt: nowMs,
            ...(draft.createdBySessionId
              ? { createdBySessionId: draft.createdBySessionId }
              : {}),
          },
        ],
        state.archived,
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
        nowMs,
      ),
    );
    return id;
  },

  updateEntry: (id, text) => {
    const target = get().entries.find((entry) => entry.id === id);
    if (!target) return null;
    // The text as the operator typed it, before it is trimmed to the store's
    // bound: cutting a long line can take away the marker that gives a key
    // away. The row's own scope is what the verdict is asked against — an
    // edit changes the wording, never where the line applies.
    const verdict = memoryRememberRefusal(
      { text, scope: target.scope },
      target.projectId,
    );
    if (verdict) return verdict;
    const normalized = normalizeMemoryText(text);
    set((state) =>
      commit(
        state.entries.map((entry) =>
          entry.id === id ? { ...entry, text: normalized } : entry,
        ),
        state.archived,
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
      ),
    );
    return null;
  },

  /**
   * The operator deleting a memory. A real deletion, with no copy left in the
   * archive.
   *
   * The archive exists because the *app* may not destroy what the operator
   * kept (LAWS/MEMORY.md, Sovereignty); it says nothing about the operator,
   * for whom delete has to mean delete. A "deleted" line still readable in a
   * panel — or still mirrored into a project folder — would make the one
   * control that removes a mistaken or private fact a lie.
   *
   * The earlier wordings this line replaced go with it, for the same reason.
   * They are not memories the operator chose to keep — they are this row's
   * own history, reachable only through it — so deleting the row and leaving
   * them would answer the next recall question with the very statement that
   * was just deleted. The panel says how many go, and every one of them is
   * listed under Archive first, so nothing leaves unseen.
   */
  forget: (id) => {
    set((state) => {
      const chain = supersededChain(state.archived, id);
      return commit(
        state.entries.filter((entry) => entry.id !== id),
        chain.size === 0
          ? state.archived
          : state.archived.filter((entry) => !chain.has(entry.id)),
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
      );
    });
  },

  restoreArchived: (id, nowMs = Date.now()) => {
    const state = get();
    const target = state.archived.find((entry) => entry.id === id);
    if (!target) return null;
    // Restoring is a write into the live list, so it answers to the same
    // verdict every other write does. The row itself is left in the archive:
    // it is still the operator's to read and to delete, it may only not go
    // back into the prompts.
    const verdict = memoryRememberRefusal(
      { text: target.text, scope: target.scope },
      target.projectId,
    );
    if (verdict) return verdict;
    const archived = state.archived.filter((entry) => entry.id !== id);
    const duplicate = existingMatch(
      state.entries,
      target.text,
      target.scope,
      target.projectId,
    );
    // Asking for a line back is the strongest evidence there is that it is
    // still true, so it re-enters at the top of the recency order the cap
    // reads. Without that a restore into a full store would be undone by the
    // very next commit — the operator clicks, and the row returns to the
    // archive it came from.
    const entries = duplicate
      ? state.entries.map((entry) =>
          entry.id === duplicate.id ? { ...entry, reinforcedAt: nowMs } : entry,
        )
      : [
          ...state.entries,
          {
            id: target.id,
            text: target.text,
            scope: target.scope,
            projectId: target.projectId,
            createdAt: target.createdAt,
            ...(target.createdBySessionId
              ? { createdBySessionId: target.createdBySessionId }
              : {}),
            reinforcedAt: nowMs,
          },
        ];
    set(() =>
      commit(
        entries,
        archived,
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
        nowMs,
      ),
    );
    return null;
  },

  deleteArchived: (id) => {
    set((state) =>
      commit(
        state.entries,
        state.archived.filter((entry) => entry.id !== id),
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
      ),
    );
  },

  forgetProject: (projectId) => {
    if (!projectId) return;
    set((state) =>
      commit(
        state.entries.filter((entry) => entry.projectId !== projectId),
        state.archived.filter((entry) => entry.projectId !== projectId),
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
      ),
    );
  },

  applyAgentRequest: (
    messageId,
    sessionId,
    projectId,
    request,
    nowMs = Date.now(),
  ) => {
    const state = get();
    if (!messageId || state.appliedMessageIds.includes(messageId)) {
      return { remembered: 0, forgotten: 0 };
    }

    // Every refusal is decided before a single line moves. A correction is
    // `forget[i]` and `remember[i]` — one fact restated — so applying the
    // retirement while refusing the replacement loses the fact altogether,
    // and loses it quietly: the operator sees a row disappear and no row
    // arrive. Refusing the pair whole leaves them with what they had.
    const refusals = request.remember.map((item) =>
      memoryRememberRefusal(item, projectId),
    );

    let entries = state.entries;
    // Forgetting still runs first so that a correction — forget the old line,
    // remember the new one — cannot have its new line eaten by a `forget`
    // that happens to read the same way.
    let forgotten = 0;
    // Position by position, so a correction can be recognised below: an
    // agent's retraction is a displacement, not the operator's delete, and
    // what it displaced is archived rather than destroyed.
    const retired: (MemoryEntry | null)[] = [];
    for (const [index, text] of request.forget.entries()) {
      // The replacement was refused, so this half of the pair does not run.
      // A `forget` with no `remember` behind it is a plain retirement and is
      // unaffected: `refusals` is only as long as the remember list.
      if (refusals[index]) {
        retired.push(null);
        continue;
      }
      const target = entries.find(
        (entry) =>
          sameMemoryText(entry.text, text) &&
          (entry.scope === "global" || entry.projectId === projectId),
      );
      retired.push(target ?? null);
      if (!target) continue;
      entries = entries.filter((entry) => entry.id !== target.id);
      forgotten += 1;
    }

    let remembered = 0;
    const rememberedIds: (string | null)[] = [];
    for (const [index, item] of request.remember.entries()) {
      // Refused silently here: a fence is not a conversation, and the store
      // has no way to answer one. The sync is what says it out loud, by kind
      // and never by value. Skipping is all that happens — the message is
      // still tombstoned below, because a refusal that left the message
      // unread would be re-refused on every store change for the life of the
      // session.
      if (refusals[index]) {
        rememberedIds.push(null);
        continue;
      }
      const text = normalizeMemoryText(item.text);
      const scopedProjectId = item.scope === "project" ? projectId : null;
      const duplicate = existingMatch(
        entries,
        text,
        item.scope,
        scopedProjectId,
      );
      if (duplicate) {
        entries = entries.map((entry) =>
          entry.id === duplicate.id ? { ...entry, reinforcedAt: nowMs } : entry,
        );
        rememberedIds.push(duplicate.id);
        continue;
      }
      const id = newMemoryId();
      entries = [
        ...entries,
        {
          id,
          text,
          scope: item.scope,
          projectId: scopedProjectId,
          createdAt: nowMs,
          createdBySessionId: sessionId,
        },
      ];
      rememberedIds.push(id);
      remembered += 1;
    }

    // A correction is read by position, the shape the protocol asks for:
    // `forget[i]` together with `remember[i]` is the same fact restated, so
    // the retired line points at the one that took its place. A `remember`
    // the store refused leaves nothing to point at, and the pair is then
    // only a retirement.
    const archivedNow: ArchivedMemoryEntry[] = [];
    for (const [index, target] of retired.entries()) {
      if (!target) continue;
      const replacedById = rememberedIds[index] ?? null;
      archivedNow.push({
        ...target,
        archivedAt: nowMs,
        archiveReason: replacedById ? "superseded" : "forgotten",
        ...(replacedById ? { replacedById } : {}),
      });
    }

    set(() =>
      commit(
        entries,
        [...state.archived, ...archivedNow],
        [...state.appliedMessageIds, messageId],
        state.recallAnsweredMessageIds,
        nowMs,
      ),
    );
    return { remembered, forgotten };
  },

  dismissAgentRequest: (messageId) => {
    const state = get();
    if (!messageId || state.appliedMessageIds.includes(messageId)) return;
    set(() =>
      commit(
        state.entries,
        state.archived,
        [...state.appliedMessageIds, messageId],
        state.recallAnsweredMessageIds,
      ),
    );
  },

  markRecallAnswered: (messageId) => {
    const state = get();
    if (!messageId || state.recallAnsweredMessageIds.includes(messageId)) {
      return;
    }
    set(() =>
      commit(state.entries, state.archived, state.appliedMessageIds, [
        ...state.recallAnsweredMessageIds,
        messageId,
      ]),
    );
  },

  replaceAll: (entries) => {
    set((state) =>
      commit(
        entries,
        state.archived,
        state.appliedMessageIds,
        state.recallAnsweredMessageIds,
      ),
    );
  },
}));
