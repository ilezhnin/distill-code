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

import type { MemoryFenceRequest } from "../lib/memoryFence";
import { findSecret } from "../lib/memoryRedaction";
import {
  mergeProjectMemories,
  readProjectMemories,
  writeProjectMemories,
} from "../lib/projectMemoryDocuments";
import {
  isMemoryArchiveReason,
  MAX_ARCHIVED_ENTRIES,
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
  updateEntry: (id: string, text: string) => void;
  forget: (id: string) => void;
  /**
   * Applies one agent message's `distill-memory` block, once.
   *
   * `projectId` scopes everything the message asks to keep at project level;
   * a message sent from a session with no project can only keep global facts,
   * because a project memory with no project is a memory nothing will ever
   * read back.
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

export function parseAppliedMemoryMessageIds(value: unknown): string[] {
  const list = (value as { appliedMessageIds?: unknown })?.appliedMessageIds;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    )
    .slice(-MAX_APPLIED_MEMORY_MESSAGE_IDS);
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
 * Trims the archive to its bound, oldest displacement first.
 *
 * The one place the app does drop a memory outright, and it is stated rather
 * than hidden: an archive that grows without end is written to disk and
 * mirrored into every project folder on every commit. Order is preserved so
 * the file stays readable as a history.
 */
export function capArchived(
  archived: ArchivedMemoryEntry[],
): ArchivedMemoryEntry[] {
  if (archived.length <= MAX_ARCHIVED_ENTRIES) return archived;
  const keep = new Set(
    archived
      .map((_, index) => index)
      .sort(
        (left, right) =>
          archived[right].archivedAt - archived[left].archivedAt ||
          right - left,
      )
      .slice(0, MAX_ARCHIVED_ENTRIES),
  );
  return archived.filter((_, index) => keep.has(index));
}

/** The archive with capacity-displaced entries folded in, bounded. */
function withCapacityEvictions(
  archived: ArchivedMemoryEntry[],
  evicted: readonly MemoryEntry[],
  nowMs: number,
): ArchivedMemoryEntry[] {
  if (evicted.length === 0) return capArchived(archived);
  return capArchived([
    ...archived,
    ...evicted.map((entry) => ({
      ...entry,
      archivedAt: nowMs,
      archiveReason: "capacity" as const,
    })),
  ]);
}

function commit(
  entries: MemoryEntry[],
  archived: ArchivedMemoryEntry[],
  appliedMessageIds: string[],
  nowMs: number = Date.now(),
): MemoryState {
  const { kept, evicted } = capWithArchive(entries);
  const next: MemoryState = {
    entries: kept,
    archived: withCapacityEvictions(archived, evicted, nowMs),
    appliedMessageIds: appliedMessageIds.slice(-MAX_APPLIED_MEMORY_MESSAGE_IDS),
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
    hydrated: true,
  };
}

const document = distillDocument<MemoryState>({
  path: MEMORY_DOCUMENT_PATH,
  legacyStorageKey: MEMORY_STORAGE_KEY,
  parse: stateFromDocument,
  // v2 adds `archived`. A v1 document reads back whole: it simply has no
  // archive yet, which is the same thing as an empty one.
  serialize: (state) => ({
    version: 2,
    entries: state.entries,
    archived: state.archived,
    appliedMessageIds: state.appliedMessageIds,
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

/** Finds an entry the given statement would duplicate, in the same reach. */
function existingMatch(
  entries: readonly MemoryEntry[],
  text: string,
  scope: MemoryScope,
  projectId: string | null,
): MemoryEntry | undefined {
  return entries.find(
    (entry) =>
      sameMemoryText(entry.text, text) &&
      (entry.scope === "global" ||
        (scope === "project" && entry.projectId === projectId)),
  );
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  entries: [],
  archived: [],
  appliedMessageIds: [],
  hydrated: false,

  remember: (draft, nowMs = Date.now()) => {
    // A statement that carries a secret is refused before anything else looks
    // at it (LAWS/MEMORY.md, Writing). The raw draft is what is scanned, not
    // the normalized one: trimming to the store's bound can cut away the very
    // marker that gives a key away. Refusal, not repair — the caller is told
    // nothing was kept, and no edited version is stored in its place.
    if (findSecret(draft.text)) return "";
    const text = normalizeMemoryText(draft.text);
    if (!text) return "";
    const projectId =
      draft.scope === "project" ? (draft.projectId ?? null) : null;
    if (draft.scope === "project" && !projectId) return "";
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
        nowMs,
      ),
    );
    return id;
  },

  updateEntry: (id, text) => {
    const normalized = normalizeMemoryText(text);
    if (!normalized) return;
    set((state) =>
      commit(
        state.entries.map((entry) =>
          entry.id === id ? { ...entry, text: normalized } : entry,
        ),
        state.archived,
        state.appliedMessageIds,
      ),
    );
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
   */
  forget: (id) => {
    set((state) =>
      commit(
        state.entries.filter((entry) => entry.id !== id),
        state.archived,
        state.appliedMessageIds,
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

    let entries = state.entries;
    // Forgetting runs first so that a correction — forget the old line,
    // remember the new one — cannot have its new line eaten by a `forget`
    // that happens to read the same way.
    let forgotten = 0;
    // Position by position, so a correction can be recognised below: an
    // agent's retraction is a displacement, not the operator's delete, and
    // what it displaced is archived rather than destroyed.
    const retired: (MemoryEntry | null)[] = [];
    for (const text of request.forget) {
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
    for (const item of request.remember) {
      // A session with no project cannot keep a project fact; keeping it
      // globally instead would be the app inventing a scope nobody asked for.
      if (item.scope === "project" && !projectId) {
        rememberedIds.push(null);
        continue;
      }
      // Same refusal the manual form gets, silently: a fence is not a
      // conversation, and the store has no way to answer one. The sync is
      // what says it out loud, by kind and never by value. Skipping is all
      // that happens — the message is still tombstoned below, because a
      // refusal that left the message unread would be re-refused on every
      // store change for the life of the session.
      if (findSecret(item.text)) {
        rememberedIds.push(null);
        continue;
      }
      const scopedProjectId = item.scope === "project" ? projectId : null;
      const duplicate = existingMatch(
        entries,
        item.text,
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
          text: item.text,
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
        nowMs,
      ),
    );
    return { remembered, forgotten };
  },

  dismissAgentRequest: (messageId) => {
    const state = get();
    if (!messageId || state.appliedMessageIds.includes(messageId)) return;
    set(() =>
      commit(state.entries, state.archived, [
        ...state.appliedMessageIds,
        messageId,
      ]),
    );
  },

  replaceAll: (entries) => {
    set((state) => commit(entries, state.archived, state.appliedMessageIds));
  },
}));
