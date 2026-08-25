/**
 * Where remembered facts live.
 *
 * localStorage, like the planner and the conductor's stores: this is the
 * operator's own state, it must survive a reload, and it must never be the
 * reason the app fails to start. Reading salvages rather than validates.
 *
 * Deliberately not a file on disk yet. A file would be editable outside the
 * app and would survive a reinstall, but writing one needs a backend command
 * the renderer does not have, and a memory the operator cannot see or delete
 * from the app would be worse than one that lives here.
 */

import { create } from "zustand";

import type { MemoryFenceRequest } from "../lib/memoryFence";
import {
  memoryRecency,
  normalizeMemoryText,
  sameMemoryText,
  type MemoryEntry,
  type MemoryScope,
} from "../lib/memoryEntry";

export const MEMORY_STORAGE_KEY = "goose:memory";

/** Upper bound on stored memories. Oldest go first. */
export const MAX_MEMORY_ENTRIES = 300;

/** Bound on the "already read this message" tombstones. */
export const MAX_APPLIED_MEMORY_MESSAGE_IDS = 2000;

interface MemoryState {
  entries: MemoryEntry[];
  appliedMessageIds: string[];
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
 * Trims to the bound, least recently useful first.
 *
 * By recency rather than age: a standing fact the agents keep restating is
 * the one worth the space, and evicting it because it was written first would
 * throw away exactly what memory is for.
 */
export function capEntries(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length <= MAX_MEMORY_ENTRIES) return entries;
  const keep = new Set(
    [...entries]
      .sort((left, right) => memoryRecency(right) - memoryRecency(left))
      .slice(0, MAX_MEMORY_ENTRIES)
      .map((entry) => entry.id),
  );
  return entries.filter((entry) => keep.has(entry.id));
}

function persist(state: MemoryState): void {
  try {
    window.localStorage.setItem(
      MEMORY_STORAGE_KEY,
      JSON.stringify({ version: 1, ...state }),
    );
  } catch {
    // localStorage may be unavailable; memory still works for this session.
  }
}

function commit(
  entries: MemoryEntry[],
  appliedMessageIds: string[],
): MemoryState {
  const next = {
    entries: capEntries(entries),
    appliedMessageIds: appliedMessageIds.slice(-MAX_APPLIED_MEMORY_MESSAGE_IDS),
  };
  persist(next);
  return next;
}

function loadPersistedState(): MemoryState {
  try {
    const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return { entries: [], appliedMessageIds: [] };
    const parsed = JSON.parse(raw);
    return {
      entries: capEntries(parseMemoryEntries(parsed)),
      appliedMessageIds: parseAppliedMemoryMessageIds(parsed),
    };
  } catch {
    return { entries: [], appliedMessageIds: [] };
  }
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
  ...loadPersistedState(),

  remember: (draft, nowMs = Date.now()) => {
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
          state.appliedMessageIds,
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
        state.appliedMessageIds,
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
        state.appliedMessageIds,
      ),
    );
  },

  forget: (id) => {
    set((state) =>
      commit(
        state.entries.filter((entry) => entry.id !== id),
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
    for (const text of request.forget) {
      const target = entries.find(
        (entry) =>
          sameMemoryText(entry.text, text) &&
          (entry.scope === "global" || entry.projectId === projectId),
      );
      if (!target) continue;
      entries = entries.filter((entry) => entry.id !== target.id);
      forgotten += 1;
    }

    let remembered = 0;
    for (const item of request.remember) {
      // A session with no project cannot keep a project fact; keeping it
      // globally instead would be the app inventing a scope nobody asked for.
      if (item.scope === "project" && !projectId) continue;
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
        continue;
      }
      entries = [
        ...entries,
        {
          id: newMemoryId(),
          text: item.text,
          scope: item.scope,
          projectId: scopedProjectId,
          createdAt: nowMs,
          createdBySessionId: sessionId,
        },
      ];
      remembered += 1;
    }

    set(() => commit(entries, [...state.appliedMessageIds, messageId]));
    return { remembered, forgotten };
  },

  replaceAll: (entries) => {
    set((state) => commit(entries, state.appliedMessageIds));
  },
}));
