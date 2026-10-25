import { useSyncExternalStore } from "react";

import { getPreferenceStorage } from "@/shared/preferences/rootSettings";

/**
 * Which chats have their started agents folded away in the sidebar.
 *
 * A chat's agents are shown under it by default: the sidebar exists to make
 * them visible, and a tree that started collapsed would put them one click
 * away from invisible again. Collapsing is the operator's choice, per chat,
 * and it survives a restart like the project folds do.
 *
 * The set is keyed by the chat's current session id. Ids are kept in the
 * order they were folded and the oldest are dropped past the cap, so a long
 * history of folded chats cannot grow the stored value without bound.
 */
export const SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY =
  "flock:sidebar:collapsed-chat-trees";

const MAX_REMEMBERED_COLLAPSED_TREES = 200;
const EMPTY: ReadonlySet<string> = new Set<string>();

let snapshot: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function readStored(): ReadonlySet<string> {
  try {
    const stored = getPreferenceStorage()?.getItem(
      SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY,
    );
    if (!stored) return EMPTY;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return EMPTY;
    return new Set(
      parsed.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    );
  } catch {
    return EMPTY;
  }
}

function current(): ReadonlySet<string> {
  if (snapshot === null) snapshot = readStored();
  return snapshot;
}

function write(next: Set<string>): void {
  while (next.size > MAX_REMEMBERED_COLLAPSED_TREES) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  snapshot = next;
  try {
    getPreferenceStorage()?.setItem(
      SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY,
      JSON.stringify([...next]),
    );
  } catch {
    // Preference storage can be unavailable; the fold still applies in-session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The chats whose agent subtree is folded, as a live set. */
export function useCollapsedChatTrees(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}

export function isChatTreeCollapsed(sessionId: string): boolean {
  return current().has(sessionId);
}

export function setChatTreeCollapsed(
  sessionId: string,
  collapsed: boolean,
): void {
  const now = current();
  if (now.has(sessionId) === collapsed) return;
  const next = new Set(now);
  if (collapsed) next.add(sessionId);
  else next.delete(sessionId);
  write(next);
}

/**
 * Unfolds the given chats. Used when the operator opens an agent's chat: the
 * row they just reached must not be hidden inside a folded ancestor.
 */
export function expandChatTrees(sessionIds: Iterable<string>): void {
  const now = current();
  let next: Set<string> | null = null;
  for (const sessionId of sessionIds) {
    if (!now.has(sessionId)) continue;
    next ??= new Set(now);
    next.delete(sessionId);
  }
  if (next) write(next);
}

/** Forgets the in-memory snapshot so the next read comes from storage. */
export function resetCollapsedChatTreesForTests(): void {
  snapshot = null;
}
