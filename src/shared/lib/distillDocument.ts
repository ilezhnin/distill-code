/**
 * One JSON document in the Distill folder, with the reading and writing that
 * every store needs done the same way.
 *
 * Three stores were keeping operator state in `localStorage`: the planner, the
 * memory and the review queue. That was browser state — invisible to a backup,
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
  /** Path under the root, e.g. `planner.json`. Must end in `.json`. */
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
}

export interface DistillDocument<T> {
  /** The stored value, migrating an old browser copy on the way if needed. */
  read: () => Promise<T | null>;
  /** Queues a write. Returns immediately. */
  write: (value: T) => void;
  /** Flushes a queued write — for tests, and for shutdown. */
  flush: () => Promise<void>;
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

export function distillDocument<T>(
  options: DistillDocumentOptions<T>,
): DistillDocument<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: unknown = null;
  let inFlight: Promise<void> = Promise.resolve();

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
    inFlight = writeDistillDocument(
      options.path,
      JSON.stringify(payload),
    ).catch((error: unknown) => {
      console.error(`Failed to write ${options.path}:`, error);
      try {
        options.onWriteError?.(error);
      } catch {
        // A reporter that throws must not reach the caller's write path.
      }
    });
    return inFlight;
  };

  return {
    read: async () => {
      if (!isDesktopRuntime()) {
        const legacy = readLegacy(options.legacyStorageKey);
        return legacy === null ? null : options.parse(legacy);
      }
      let stored: unknown = null;
      try {
        const raw = await readDistillDocument(options.path);
        stored = raw === null ? null : JSON.parse(raw);
      } catch (error) {
        console.error(`Failed to read ${options.path}:`, error);
        stored = null;
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
    },

    write: (value) => {
      pending = options.serialize(value);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        void flushNow();
      }, DISTILL_WRITE_DEBOUNCE_MS);
    },

    flush: () => flushNow(),
  };
}
