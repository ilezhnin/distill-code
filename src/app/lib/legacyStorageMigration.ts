// Runs as the very first import of main.tsx, so every module that reads a
// preference while it is being imported already sees the migrated keys.
//
// Goose-era builds stored preferences as `goose:<name>` / `goose.<name>`; the
// app now reads `distill:<name>` / `distill.<name>`. One broken build (178a1d6)
// moved every `distill:<name>` to `distillll:<name>` on each boot; those
// values are restored here too. The newest copy wins: an existing
// `distill:` key, then the misnamed `distillll:` copy, then the goose one.

const RETIRED_KEYS = ["goose:onboarding:v1", "berd:onboarding:v1"];
const LEGACY_PREFIXES = [
  ["distillll:", "distill:"],
  ["goose:", "distill:"],
  ["goose.", "distill."],
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
