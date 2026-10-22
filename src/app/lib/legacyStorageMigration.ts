// Runs as the very first import of main.tsx, so every module that reads a
// preference while it is being imported already sees the migrated keys.
//
// Goose-era builds stored preferences as `goose:<name>` / `goose.<name>`,
// Distill-era builds as `distill:<name>` / `distill.<name>`; the app now
// reads `flock:<name>` / `flock.<name>`. One broken Distill build (178a1d6)
// moved every `distill:<name>` to `distillll:<name>` on each boot; those
// values are restored here too. The newest copy wins: an existing `flock:`
// key, then the `distill:` one, then the misnamed `distillll:` copy, then the
// goose one.
//
// The left column holds the former spellings on purpose: they are read-only
// compatibility literals, and the unit test pins the whole table so a rename
// sweep that rewrote a row to `["flock:", "flock:"]` (which would delete
// every current key) fails the suite instead of shipping.

export const RETIRED_KEYS = [
  "goose:onboarding:v1",
  "berd:onboarding:v1",
] as const;
export const LEGACY_PREFIXES = [
  ["distill:", "flock:"],
  ["distill.", "flock."],
  ["distillll:", "flock:"],
  ["goose:", "flock:"],
  ["goose.", "flock."],
] as const;

export function migrateLegacyStorage(storage: Storage): void {
  for (const key of RETIRED_KEYS) storage.removeItem(key);
  for (const [legacy, current] of LEGACY_PREFIXES) {
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(legacy)) continue;
      const renamed = `${current}${key.slice(legacy.length)}`;
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(renamed) === null) {
        storage.setItem(renamed, value);
      }
      storage.removeItem(key);
    }
  }
}

try {
  migrateLegacyStorage(localStorage);
} catch {
  // localStorage may be unavailable in some environments; ignore.
}
