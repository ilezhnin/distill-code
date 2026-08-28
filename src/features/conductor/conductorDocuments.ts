/**
 * The conductor's own state, as files in the Distill folder (P24).
 *
 * The graph, the waves and the telemetry were the last three stores keeping
 * operator state in `localStorage`, and they were the worst three to leave
 * there. An origin has about five megabytes; past it every write silently
 * does nothing, the app keeps rendering the live wave from memory exactly as
 * before, and the next restart comes up with no waves, no executors and no
 * explanation. `persistHealth` exists only to make that interval sayable —
 * this is the fix it was waiting for. The same move also makes a brigade
 * portable: copying a `.distill` folder to another machine now carries the
 * agents and their reports with it, which browser storage never could.
 *
 * The sequencing is the whole design, and it has one rule: **the folder never
 * overwrites what is already in memory.**
 *
 * Each store still loads synchronously from `localStorage` at module init, so
 * the app outside the desktop shell — tests, a browser preview — behaves
 * exactly as it did. On the desktop the folder is read afterwards, which is
 * asynchronous, and by then a session could already have registered a node.
 * So hydration *merges*: entries the folder knows about and memory does not
 * are added, and anything memory already holds wins. A first run migrates in
 * the other direction — `distillDocument` finds no file, writes the browser
 * copy into the folder and drops the browser copy — after which the
 * synchronous load reads an empty `localStorage` and the folder is the only
 * source there is.
 */

import { isDesktopRuntime } from "@/shared/api/distillStore";
import { distillDocument } from "@/shared/lib/distillDocument";

import { notePersistFailure, type PersistScope } from "./persistHealth";

/** Where each store's document lives under the Distill root. */
export const CONDUCTOR_GRAPH_DOCUMENT = "conductor/graph.json";
export const CONDUCTOR_WAVES_DOCUMENT = "conductor/waves.json";
export const WAVE_TELEMETRY_DOCUMENT = "conductor/telemetry.json";

/**
 * A store's folder document, or `null` off the desktop.
 *
 * Returning `null` rather than a no-op object is deliberate: every caller has
 * to branch anyway — off the desktop it keeps writing to `localStorage`
 * synchronously, which is what its tests assert — and a silent no-op would
 * make that branch invisible.
 */
export function conductorDocument<T>(options: {
  path: string;
  legacyStorageKey: string;
  scope: PersistScope;
  parse: (raw: unknown) => T;
  serialize: (value: T) => unknown;
}) {
  const document = distillDocument<T>({
    path: options.path,
    legacyStorageKey: options.legacyStorageKey,
    parse: options.parse,
    serialize: options.serialize,
    onWriteError: (error) => notePersistFailure(options.scope, error),
  });
  return {
    /** True when this document is the store's persistence, not `localStorage`. */
    get active(): boolean {
      return isDesktopRuntime();
    },
    read: () => document.read(),
    write: (value: T) => document.write(value),
    flush: () => document.flush(),
  };
}
