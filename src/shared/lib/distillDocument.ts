/**
 * One JSON document in the Distill folder, with the reading and writing that
 * every store needs done the same way.
 *
 * Memory and the review queue used to keep operator state in `localStorage`.
 * That was browser state, invisible to a backup,
 * unreadable by a person, gone on a reinstall — while the same operator's
 * projects, sessions and skills were real files. This is what moves them.
 *
 * Three properties matter and none of them is optional:
 *
 * - **Reading salvages.** A document that will not parse must cost the rows it
 *   cannot read, not the whole list. Callers supply `parse`, which is expected
 *   to drop what it cannot understand and return the rest.
 * - **Writing is debounced and never awaited by the UI.** Ticking a task off
 *   must not wait on a disk round trip, and holding a repeat key down must not
 *   queue fifty writes.
 * - **The old `localStorage` copy is migrated once, then removed.** Leaving it
 *   behind would give the next reinstall two sources of truth that disagree.
 */

import {
  isDesktopRuntime,
  readDistillDocument,
  writeDistillDocument,
} from "@/shared/api/distillStore";

/** How long writes are coalesced. Long enough for a burst, short enough that
 *  closing the app a moment after a change keeps it. */
export const DISTILL_WRITE_DEBOUNCE_MS = 250;

export interface DistillDocumentOptions<T> {
  /** Path under the root, e.g. `memory.json`. Must end in `.json`. */
  path: string;
  /** Key this document used to live under in `localStorage`. */
  legacyStorageKey: string;
  /** Reads stored JSON into the caller's shape, salvaging what it can. */
  parse: (raw: unknown) => T;
  /** The value to store. */
  serialize: (value: T) => unknown;
  /**
   * Called when a queued write could not be made durable.
   *
   * The write is swallowed either way — a full disk must not take a running
   * wave down with it — but a caller that has somewhere to record the failure
   * (the conductor's `persistHealth`) can no longer only find out by reading
   * the console.
   */
  onWriteError?: (error: unknown) => void;
  /**
   * Remember this instance's recent writes, so that
   * {@link DistillDocument.readExternal} can tell its own write coming back
   * from another window's. Off by default, since it keeps the text of those
   * writes alive; only a document that re-reads on change notices needs it.
   */
  recognizeOwnWrites?: boolean;
}

export interface DistillDocument<T> {
  /**
   * The stored value, migrating an old browser copy on the way if needed.
   * `null` means there is no document. Rejects when one exists but cannot be
   * read, so the caller never mistakes it for an empty one.
   */
  read: () => Promise<T | null>;
  /**
   * Reads the document after a change notice, or resolves `undefined` when the
   * stored text is exactly what this instance itself wrote lately.
   *
   * The native store announces every write to every window, the writer
   * included, so a store that re-reads on that notice would otherwise parse
   * its own write back — for the usage ledger, half a megabyte, and often
   * enough to queue yet another write.
   */
  readExternal: () => Promise<T | null | undefined>;
  /** Queues a write. Returns immediately. */
  write: (value: T) => void;
  /** Flushes a queued write — for tests, and for shutdown. */
  flush: () => Promise<void>;
  /**
   * Flushes a queued write and stops tracking the document for the flush on
   * window close. For documents with a bounded life, such as one wave's run
   * journal: without it every one ever opened stays referenced until the
   * window goes away.
   */
  dispose: () => Promise<void>;
}

/**
 * Every document created in this renderer and not yet disposed, so a teardown
 * can flush the ones still holding a debounced payload.
 *
 * The webview is destroyed without warning when the window closes, and the
 * only signals that reliably precede that are `pagehide` and `beforeunload`;
 * both are hooked because WebView2 does not always deliver `pagehide` on a
 * controller close. A flush is fire-and-forget — nothing on the Rust side
 * defers the window's destruction until pending commands finish, so a write
 * queued in the last few milliseconds can still be lost. Closing that gap
 * needs a `WindowEvent::CloseRequested` hold in `src-tauri` (see the audit's
 * shared #4 follow-up).
 */
const openDocuments = new Set<{ flush: () => Promise<void> }>();
let closeFlushInstalled = false;

/** How many documents the close flush is tracking. Tests only. */
export function openDistillDocumentCountForTests(): number {
  return openDocuments.size;
}

/**
 * Most own writes an instance remembers while their change notices are on the
 * way. A notice is normally matched before the next write is made, so this
 * only bounds a burst of writes, or a window whose notices never arrive.
 */
const MAX_REMEMBERED_OWN_WRITES = 4;

function installCloseFlush(): void {
  if (closeFlushInstalled || typeof window === "undefined") return;
  closeFlushInstalled = true;
  const flushAll = () => {
    for (const entry of openDocuments) {
      void entry.flush().catch(() => {
        // Already reported by the write path; a teardown must not throw.
      });
    }
  };
  window.addEventListener("pagehide", flushAll);
  window.addEventListener("beforeunload", flushAll);
}

function readLegacy(key: string): unknown | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLegacy(key: string, payload: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable; the value still holds for this session.
  }
}

/** `memory.json` → `memory.corrupt-<ms>.json`, beside the original. */
export function corruptCopyPath(path: string, nowMs = Date.now()): string {
  const stem = path.replace(/\.json$/i, "");
  return `${stem}.corrupt-${nowMs}.json`;
}

export function distillDocument<T>(
  options: DistillDocumentOptions<T>,
): DistillDocument<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: unknown = null;
  let inFlight: Promise<void> = Promise.resolve();
  /**
   * The text of this instance's writes whose change notice may still be on
   * the way, oldest first; only kept with `recognizeOwnWrites`.
   *
   * Notices arrive in write order, so a read that comes back with one of these
   * drops the older ones. It keeps the one it matched: the read after the next
   * notice can return that same text, when the next write has not landed yet.
   */
  let ownWrites: string[] = [];

  const rememberOwnWrite = (contents: string): void => {
    if (!options.recognizeOwnWrites) return;
    ownWrites.push(contents);
    if (ownWrites.length > MAX_REMEMBERED_OWN_WRITES) ownWrites.shift();
  };

  const isOwnWrite = (raw: string): boolean => {
    const index = ownWrites.lastIndexOf(raw);
    if (index < 0) return false;
    ownWrites = ownWrites.slice(index);
    return true;
  };

  const flushNow = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return inFlight;
    const payload = pending;
    pending = null;
    if (!isDesktopRuntime()) {
      writeLegacy(options.legacyStorageKey, payload);
      return inFlight;
    }
    // Chained, not concurrent: two flushes close together would otherwise run
    // two `write_distill_document` invokes at once, and the temp-file rename of
    // the older payload can land after the newer one — leaving the previous
    // version on disk while memory holds the newer one.
    inFlight = inFlight
      .then(() => {
        const contents = JSON.stringify(payload);
        // Remembered before the write is handed over: the store announces it
        // before the invoke returns, so the notice can beat the resolution.
        rememberOwnWrite(contents);
        return writeDistillDocument(options.path, contents);
      })
      .catch((error: unknown) => {
        console.error(`Failed to write ${options.path}:`, error);
        try {
          options.onWriteError?.(error);
        } catch {
          // A reporter that throws must not reach the caller's write path.
        }
      });
    return inFlight;
  };

  const readLegacyValue = (): T | null => {
    const legacy = readLegacy(options.legacyStorageKey);
    return legacy === null ? null : options.parse(legacy);
  };

  /** What a read of the stored text resolves to, on the desktop. */
  const settleStored = async (raw: string | null): Promise<T | null> => {
    let stored: unknown = null;
    if (raw !== null) {
      try {
        stored = JSON.parse(raw);
      } catch (error) {
        console.error(`Failed to parse ${options.path}:`, error);
        // The next write replaces this file, so keep the unparseable text
        // beside it for a person to recover. Should that copy fail too,
        // throw rather than start from empty over the only copy.
        await writeDistillDocument(corruptCopyPath(options.path), raw);
      }
    }
    if (stored !== null) return options.parse(stored);

    // Nothing on disk: this may be the first run after the move. Take the
    // browser copy, write it where it belongs, and drop it — two sources of
    // truth that can drift is exactly what this is fixing.
    const legacy = readLegacy(options.legacyStorageKey);
    if (legacy === null) return null;
    const migrated = options.parse(legacy);
    try {
      await writeDistillDocument(
        options.path,
        JSON.stringify(options.serialize(migrated)),
      );
      window.localStorage.removeItem(options.legacyStorageKey);
    } catch (error) {
      // Keep the browser copy if the move failed; losing it would lose the
      // data outright.
      console.error(`Failed to migrate ${options.legacyStorageKey}:`, error);
    }
    return migrated;
  };

  const instance: DistillDocument<T> = {
    read: async () => {
      if (!isDesktopRuntime()) return readLegacyValue();
      // A document that exists but cannot be read is not an empty one: the
      // caller would mark itself hydrated and its next write would replace
      // the operator's data. Throw instead, so the store stays unhydrated,
      // keeps this run's changes in memory, and the next start tries again.
      return settleStored(await readDistillDocument(options.path));
    },

    readExternal: async () => {
      if (!isDesktopRuntime()) return readLegacyValue();
      const raw = await readDistillDocument(options.path);
      if (raw !== null && isOwnWrite(raw)) return undefined;
      return settleStored(raw);
    },

    write: (value) => {
      pending = options.serialize(value);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        void flushNow();
      }, DISTILL_WRITE_DEBOUNCE_MS);
    },

    flush: () => flushNow(),

    dispose: () => {
      openDocuments.delete(instance);
      return flushNow();
    },
  };

  openDocuments.add(instance);
  installCloseFlush();
  return instance;
}
