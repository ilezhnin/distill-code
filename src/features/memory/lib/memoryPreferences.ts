/**
 * The operator's pause switch for memory.
 *
 * The memory ACL already answers "who may write" (`memoryWriteAccess`), and
 * the project scope answers "where does this reach". Neither answers the
 * question an operator actually asks when they open a shared screen or start
 * a throwaway experiment: *stop, for now*. That is this file — two switches,
 * user-local, on by default, and deliberately blunt:
 *
 * - `write`: agents may keep and retire memories through the fence.
 * - `read`: sessions are told what is remembered.
 *
 * Stored the way experiments are (`experimentPreferences.ts`): one versioned
 * localStorage record plus a change event, so a toggle in settings reaches
 * the send paths and the drains in the same tick. It is not an experiment —
 * it is a standing preference that outlives any graduation — but there is no
 * reason to invent a second storage mechanism for it.
 *
 * Neither switch deletes anything. A paused memory is still the operator's
 * data, still listed and searchable in settings (LAWS/MEMORY.md,
 * Sovereignty); it simply stops travelling.
 */

import { useSyncExternalStore } from "react";

import type { MemoryEntry } from "./memoryEntry";
import { composeMemorySection } from "./memoryPrompt";

export const MEMORY_PREFERENCES_STORAGE_KEY = "goose:memory-preferences";
export const MEMORY_PREFERENCES_STORAGE_VERSION = 1;
export const MEMORY_PREFERENCES_CHANGE_EVENT =
  "goose:memory-preferences-change";

const EMPTY_STORAGE_SNAPSHOT = "__goose_memory_preferences_empty__";

export interface MemoryPreferences {
  /** Agents may keep and retire memories through the `distill-memory` fence. */
  write: boolean;
  /** Sessions are told what is remembered, and how to ask for the rest. */
  read: boolean;
}

interface StoredPreferences {
  version: number;
  write?: boolean;
  read?: boolean;
}

/**
 * Both on. Memory that has to be switched on is memory nobody switches on,
 * and the feature's whole value is the facts the operator never had to
 * repeat — so the pause is opt-in, not the memory.
 */
const DEFAULT_PREFERENCES: MemoryPreferences = { write: true, read: true };

let snapshotCache: { key: string; value: MemoryPreferences } | undefined;

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function defaultStoredPreferences(): StoredPreferences {
  return { version: MEMORY_PREFERENCES_STORAGE_VERSION };
}

function readStorageValue(): string | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    return storage.getItem(MEMORY_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parseStoredPreferencesValue(parsed: unknown): StoredPreferences {
  if (!isRecord(parsed)) return defaultStoredPreferences();
  // An unrecognised version is discarded rather than half-read: a switch
  // guessed wrong is either memory that keeps travelling after the operator
  // said stop, or memory that silently stops.
  if (parsed.version !== MEMORY_PREFERENCES_STORAGE_VERSION) {
    return defaultStoredPreferences();
  }

  return {
    version: MEMORY_PREFERENCES_STORAGE_VERSION,
    write: typeof parsed.write === "boolean" ? parsed.write : undefined,
    read: typeof parsed.read === "boolean" ? parsed.read : undefined,
  };
}

function readStoredPreferences(): StoredPreferences {
  const rawValue = readStorageValue();
  if (!rawValue) return defaultStoredPreferences();

  try {
    return parseStoredPreferencesValue(JSON.parse(rawValue));
  } catch {
    return defaultStoredPreferences();
  }
}

/**
 * The record a write may safely be built on, or nothing.
 *
 * A newer schema than this build understands aborts the write instead of
 * overwriting it — the same rule experiments follow, and for a sharper
 * reason here: flattening a future field could turn a switch the operator
 * set back on.
 */
function readLatestWritablePreferences(): StoredPreferences | null {
  const storage = getStorage();
  if (!storage) return null;

  let rawValue: string | null = null;
  try {
    rawValue = storage.getItem(MEMORY_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!rawValue) return defaultStoredPreferences();

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (
      isRecord(parsed) &&
      typeof parsed.version === "number" &&
      parsed.version > MEMORY_PREFERENCES_STORAGE_VERSION
    ) {
      return null;
    }
    return parseStoredPreferencesValue(parsed);
  } catch {
    return defaultStoredPreferences();
  }
}

function writeStoredPreferences(nextPreferences: StoredPreferences): boolean {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.setItem(
      MEMORY_PREFERENCES_STORAGE_KEY,
      JSON.stringify(nextPreferences),
    );
  } catch {
    return false;
  }

  window.dispatchEvent(new CustomEvent(MEMORY_PREFERENCES_CHANGE_EVENT));
  return true;
}

function writeMemoryPreference(patch: Partial<MemoryPreferences>): boolean {
  const latestPreferences = readLatestWritablePreferences();
  if (!latestPreferences) return false;

  return writeStoredPreferences({
    ...latestPreferences,
    version: MEMORY_PREFERENCES_STORAGE_VERSION,
    ...patch,
  });
}

export function getMemoryPreferences(): MemoryPreferences {
  const stored = readStoredPreferences();
  return {
    write: stored.write ?? DEFAULT_PREFERENCES.write,
    read: stored.read ?? DEFAULT_PREFERENCES.read,
  };
}

export function setMemoryWriteEnabled(enabled: boolean): boolean {
  return writeMemoryPreference({ write: enabled });
}

export function setMemoryReadEnabled(enabled: boolean): boolean {
  return writeMemoryPreference({ read: enabled });
}

export function subscribeToMemoryPreferenceChanges(
  onStoreChange: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key === MEMORY_PREFERENCES_STORAGE_KEY || event.key === null) {
      onStoreChange();
    }
  };

  window.addEventListener(MEMORY_PREFERENCES_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(MEMORY_PREFERENCES_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getMemoryPreferencesSnapshot(): MemoryPreferences {
  const storageKey = readStorageValue() ?? EMPTY_STORAGE_SNAPSHOT;
  if (snapshotCache?.key === storageKey) return snapshotCache.value;

  const value = getMemoryPreferences();
  snapshotCache = { key: storageKey, value };
  return value;
}

export function useMemoryPreferences(): MemoryPreferences {
  return useSyncExternalStore(
    subscribeToMemoryPreferenceChanges,
    getMemoryPreferencesSnapshot,
    getMemoryPreferencesSnapshot,
  );
}

/**
 * The read switch, applied where the section is built.
 *
 * The one gate every send path goes through, rather than a check inside
 * `composeMemorySection`: the composer is a pure formatter that the settings
 * panel also reads through, and a preference read from inside it would make
 * the panel's "in the prompt" badge lie the moment the switch went off for a
 * different reason than the budget.
 *
 * The switch is passed in rather than read here so the caller decides which
 * snapshot it composed against — a React caller hands over the one it
 * subscribed to, which is what makes an open chat's prompt recompose the
 * moment the operator flips it.
 *
 * It takes out the whole section on purpose. The remembered block, the write
 * protocol and the recall protocol travel as one thing, and a session taught
 * to ask for memories that will never be mixed in is a session promised an
 * answer nobody is going to give.
 */
export function composeGatedMemorySection(
  preferences: MemoryPreferences,
  entries: readonly MemoryEntry[],
  archivedCount: number,
  projectId: string | null,
  writeAllowed: boolean,
): string | undefined {
  if (!preferences.read) return undefined;
  return composeMemorySection(entries, archivedCount, projectId, writeAllowed);
}
