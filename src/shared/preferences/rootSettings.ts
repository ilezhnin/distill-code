// Preference readers are imported during locale/bootstrap setup. Load native
// APIs only when desktop hydration starts, not when these readers are imported.
function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}
async function readGlobalSettings(): Promise<Record<string, unknown>> {
  const { readDistillDocument } = await import("@/shared/api/distillStore");
  return parseSettings(await readDistillDocument("settings.json"));
}
async function updateSettings(
  patch: Record<string, unknown>,
  onlyMissing = false,
): Promise<void> {
  const { invokeWithStartupRetry } = await import(
    "@/shared/api/invokeWithStartupRetry"
  );
  await invokeWithStartupRetry("update_distill_settings", {
    patch,
    onlyMissing,
  });
}

/** Human-editable settings.json keys, with the former browser keys for migration. */
export const PREFERENCE_KEYS = [
  "style-guidelines",
  "locale",
  "keyboard-shortcuts:v1",
  "experimental-features",
  "memory-preferences",
  "assistive-ux",
  "notifications",
  "auto-archive-unpinned-after",
  "auto-archive-unpinned-consented",
  "at-mention-default-category",
  "multi-workspace-enabled",
  "artifact-root-path",
  "artifact-auto-open",
  "harness-subagent-reveal",
  "working-indicator-animation-enabled",
  "preferredModelsByAgent",
  "streaming-shortcut-mode",
  "theme-mode",
  "primary-color",
  "defaultProvider",
  "session-cost-enabled",
  "response-start-gutter-enabled",
  "status-bar-usage-mode",
  "zoom-level",
  "trusted-domains",
  "terminal-fallback-cwd",
  "providerConnections:v1",
  "chat-workspace-metadata",
] as const;

function legacyKey(name: string): string {
  if (name === "trusted-domains") return "goose_trusted_domains";
  if (name === "theme-mode") return "goose-theme-mode";
  if (name === "primary-color") return "goose-primary-color";
  if (name === "zoom-level") return "goose-zoom-level";
  return `distill:${name}`;
}

let settings: Record<string, unknown> = {};
let ready = false;
let initializing: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();
const pending = new Map<string, unknown>();
let refreshing: Promise<void> | undefined;
let revision = 0;

function decode(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function encode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
function parseSettings(raw: string | null): Record<string, unknown> {
  const value: unknown = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings.json must contain an object");
  }
  return value as Record<string, unknown>;
}
function settingKey(key: string): string | null {
  return PREFERENCE_KEYS.find((name) => legacyKey(name) === key) ?? null;
}

export async function initializeRootSettings(): Promise<void> {
  if (!isDesktopRuntime()) return;
  initializing ??= (async () => {
    settings = await readGlobalSettings();
    const migrated: Record<string, unknown> = {};
    for (const name of PREFERENCE_KEYS) {
      const raw = window.localStorage.getItem(legacyKey(name));
      if (raw !== null && !(name in settings)) migrated[name] = decode(raw);
    }
    if (Object.keys(migrated).length) {
      await updateSettings(migrated, true);
      settings = await readGlobalSettings();
    }
    ready = true;
    for (const name of PREFERENCE_KEYS)
      window.localStorage.removeItem(legacyKey(name));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    window.addEventListener("focus", () => {
      void refreshRootSettings().catch(console.error);
    });
    const { listen } = await import("@tauri-apps/api/event");
    await listen("distill-settings-changed", () => {
      void refreshRootSettings().catch(console.error);
    });
  })().catch((error: unknown) => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

export async function refreshRootSettings(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await initializeRootSettings();
  refreshing ??= (async () => {
    await writes;
    const startedAtRevision = revision;
    const loaded = await readGlobalSettings();
    // A write accepted during the read may already have left `pending`.
    // Keep the newer in-memory snapshot and let the next refresh read it.
    if (revision !== startedAtRevision) return;
    for (const [name, value] of pending) {
      if (value === null) delete loaded[name];
      else loaded[name] = value;
    }
    settings = loaded;
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

function writeSetting(name: string, value: unknown): void {
  if (!ready) throw new Error("Distill settings have not loaded yet");
  revision += 1;
  if (value === null) delete settings[name];
  else settings[name] = value;
  pending.set(name, value);
  // The backend merges each patch under a lock, so a second window cannot
  // overwrite unrelated settings from an older renderer snapshot.
  writes = writes
    .catch(() => {})
    .then(async () => {
      const patch = Object.fromEntries(pending);
      if (!Object.keys(patch).length) return;
      await updateSettings(patch);
      for (const [key, saved] of Object.entries(patch)) {
        if (pending.get(key) === saved) pending.delete(key);
      }
    });
  void writes.catch((error: unknown) => {
    console.error("Cannot save Distill settings", error);
    window.dispatchEvent(
      new CustomEvent("distill-settings-error", { detail: String(error) }),
    );
  });
}

const storage: Storage = {
  get length() {
    return PREFERENCE_KEYS.length;
  },
  key(index) {
    return PREFERENCE_KEYS[index] ? legacyKey(PREFERENCE_KEYS[index]) : null;
  },
  getItem(key) {
    const name = settingKey(key);
    return name && ready
      ? encode(settings[name])
      : window.localStorage.getItem(key);
  },
  setItem(key, value) {
    const name = settingKey(key);
    if (name) writeSetting(name, decode(value));
    else window.localStorage.setItem(key, value);
  },
  removeItem(key) {
    const name = settingKey(key);
    if (name) writeSetting(name, null);
    else window.localStorage.removeItem(key);
  },
  clear() {
    for (const name of PREFERENCE_KEYS) writeSetting(name, null);
  },
};

export function getPreferenceStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return isDesktopRuntime() ? storage : window.localStorage;
}

/** Project overrides never mutate global settings or another project's cache. */
export async function readEffectiveSettings(
  projectRoot?: string | null,
): Promise<Record<string, unknown>> {
  await refreshRootSettings();
  const global = isDesktopRuntime()
    ? settings
    : Object.fromEntries(
        PREFERENCE_KEYS.flatMap((name) => {
          const raw = getPreferenceStorage()?.getItem(legacyKey(name));
          return raw == null ? [] : [[name, decode(raw)]];
        }),
      );
  if (!projectRoot) return { ...global };
  const { initializeProjectContext, readProjectDocument } = await import(
    "@/shared/api/projectStore"
  );
  await initializeProjectContext(projectRoot);
  const project = parseSettings(
    await readProjectDocument(projectRoot, "settings.json"),
  );
  return { ...global, ...project };
}

export function flushRootSettings(): Promise<void> {
  return writes;
}
