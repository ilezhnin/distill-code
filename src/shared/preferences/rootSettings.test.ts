import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const projectRead = vi.hoisted(() => vi.fn());
const projectInit = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/flockStore", () => ({ readFlockDocument: read }));
vi.mock("@/shared/api/invokeWithStartupRetry", () => ({
  invokeWithStartupRetry: update,
}));
vi.mock("@/shared/api/projectStore", () => ({
  readProjectDocument: projectRead,
  initializeProjectContext: projectInit,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

let disk: Record<string, unknown>;
let addListener: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
    writable: true,
  });
  disk = {};
  read.mockImplementation(async () => JSON.stringify(disk));
  projectRead.mockResolvedValue(null);
  projectInit.mockResolvedValue(undefined);
  update.mockImplementation(
    async (
      _command: string,
      {
        patch,
        onlyMissing,
      }: { patch: Record<string, unknown>; onlyMissing?: boolean },
    ) => {
      for (const [name, value] of Object.entries(patch)) {
        if (onlyMissing && name in disk) continue;
        if (value === null) delete disk[name];
        else disk[name] = value;
      }
    },
  );
  addListener = vi.spyOn(window, "addEventListener");
});

afterEach(() => {
  for (const [name, listener] of addListener.mock.calls)
    window.removeEventListener(name, listener);
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("Flock root settings", () => {
  it("names every browser-era preference key with the flock: prefix", async () => {
    const settings = await import("./rootSettings");
    const storage = settings.getPreferenceStorage();
    const gooseNamed = new Map([
      ["trusted-domains", "goose_trusted_domains"],
      ["theme-mode", "goose-theme-mode"],
      ["primary-color", "goose-primary-color"],
      ["zoom-level", "goose-zoom-level"],
    ]);
    const keys = settings.PREFERENCE_KEYS.map((_, index) =>
      storage?.key(index),
    );
    expect(keys).toEqual(
      settings.PREFERENCE_KEYS.map(
        (name) => gooseNamed.get(name) ?? `flock:${name}`,
      ),
    );
    expect(storage?.key(settings.PREFERENCE_KEYS.length)).toBeNull();
  });

  it("adopts a preference the previous product left in the browser", async () => {
    // main.tsx runs the legacy storage migration before this module loads,
    // so the previous product's `<old>:locale` is read as `flock:locale`.
    // The old name is spelled in halves so a rename sweep cannot rewrite it.
    const previous = ["dis", "till"].join("");
    localStorage.setItem(`${previous}:locale`, "es");
    localStorage.setItem(`${previous}:sidebar:layout`, "unchanged");
    const { migrateLegacyStorage } = await import(
      "@/app/lib/legacyStorageMigration"
    );
    migrateLegacyStorage(localStorage);
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    expect(disk).toEqual({ locale: "es" });
    expect(settings.getPreferenceStorage()?.getItem("flock:locale")).toBe("es");
    expect(localStorage.getItem("flock:locale")).toBeNull();
    expect(localStorage.getItem(`${previous}:locale`)).toBeNull();
    expect(localStorage.getItem("flock:sidebar:layout")).toBe("unchanged");
  });

  it("keeps a write accepted while a stale disk refresh is in flight", async () => {
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    let resolveRead!: (raw: string) => void;
    read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const refresh = settings.refreshRootSettings();
    await vi.waitFor(() => expect(resolveRead).toBeDefined());
    settings.getPreferenceStorage()?.setItem("flock:locale", "es");
    await settings.flushRootSettings();
    resolveRead('{"locale":"en"}');
    await refresh;
    expect(settings.getPreferenceStorage()?.getItem("flock:locale")).toBe("es");
    expect(disk.locale).toBe("es");
  });
  it("migrates browser preferences once, preserving disk values and UI state", async () => {
    disk = { locale: "es", custom: { retained: true } };
    localStorage.setItem("flock:locale", "en");
    localStorage.setItem("flock:notifications", '{"enabled":false}');
    localStorage.setItem("flock:sidebar:layout", "unchanged");
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    expect(disk).toEqual({
      locale: "es",
      custom: { retained: true },
      notifications: { enabled: false },
    });
    expect(settings.getPreferenceStorage()?.getItem("flock:locale")).toBe("es");
    expect(localStorage.getItem("flock:notifications")).toBeNull();
    expect(localStorage.getItem("flock:sidebar:layout")).toBe("unchanged");
    await settings.initializeRootSettings();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser copy when migration fails and retries on the next start attempt", async () => {
    localStorage.setItem("flock:locale", "es");
    update.mockRejectedValueOnce(new Error("disk unavailable"));
    const settings = await import("./rootSettings");
    await expect(settings.initializeRootSettings()).rejects.toThrow(
      "disk unavailable",
    );
    expect(localStorage.getItem("flock:locale")).toBe("es");
    await settings.initializeRootSettings();
    expect(disk.locale).toBe("es");
    expect(localStorage.getItem("flock:locale")).toBeNull();
  });

  it("does not overwrite malformed operator settings", async () => {
    localStorage.setItem("flock:locale", "es");
    read.mockResolvedValueOnce("not JSON");
    const settings = await import("./rootSettings");
    await expect(settings.initializeRootSettings()).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(localStorage.getItem("flock:locale")).toBe("es");
  });

  it("writes only changed keys and keeps an unrelated edit from another window", async () => {
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    disk.locale = "es";
    settings
      .getPreferenceStorage()
      ?.setItem("flock:notifications", '{"enabled":false}');
    await settings.flushRootSettings();
    expect(disk).toEqual({ locale: "es", notifications: { enabled: false } });
    expect(localStorage.getItem("flock:notifications")).toBeNull();
  });

  it("retries failed writes without dropping earlier changed keys", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    update.mockRejectedValue(new Error("offline"));
    settings.getPreferenceStorage()?.setItem("flock:locale", "es");
    await expect(settings.flushRootSettings()).rejects.toThrow("offline");
    update.mockImplementation(async (_command, { patch }) => {
      Object.assign(disk, patch);
    });
    await settings.flushRootSettings();
    expect(disk).toEqual({ locale: "es" });
    settings
      .getPreferenceStorage()
      ?.setItem("flock:notifications", '{"enabled":false}');
    await settings.flushRootSettings();
    expect(disk).toEqual({ locale: "es", notifications: { enabled: false } });
  });

  it("merges the selected project's overrides without leaking them into another project", async () => {
    disk = { "style-guidelines": { prompt: "Global" }, locale: "es" };
    projectRead.mockImplementation(async (root: string) =>
      root === "C:/project-a"
        ? '{"style-guidelines":{"prompt":"Project A"}}'
        : null,
    );
    const settings = await import("./rootSettings");
    expect(await settings.readEffectiveSettings("C:/project-a")).toEqual({
      "style-guidelines": { prompt: "Project A" },
      locale: "es",
    });
    expect(await settings.readEffectiveSettings("C:/project-b")).toEqual(disk);
    expect(await settings.readEffectiveSettings()).toEqual(disk);
    expect(projectInit).toHaveBeenCalledWith("C:/project-a");
    expect(update).not.toHaveBeenCalled();
  });

  it("encodes an unchanged object value once, however often it is read", async () => {
    disk = { "chat-workspace-metadata": { s1: { workingDir: "C:/a" } } };
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    const storage = settings.getPreferenceStorage();
    const key = "flock:chat-workspace-metadata";
    const stringify = vi.spyOn(JSON, "stringify");
    const first = storage?.getItem(key);
    const second = storage?.getItem(key);
    const third = storage?.getItem(key);
    const encodes = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(encodes).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(JSON.parse(first ?? "null")).toEqual({
      s1: { workingDir: "C:/a" },
    });

    // A write replaces the value, so the next read encodes the new one.
    storage?.setItem(key, '{"s1":{"workingDir":"C:/b"}}');
    expect(JSON.parse(storage?.getItem(key) ?? "null")).toEqual({
      s1: { workingDir: "C:/b" },
    });
    await settings.flushRootSettings();

    // So does a refresh that picked up another window's edit.
    disk["chat-workspace-metadata"] = { s1: { workingDir: "C:/c" } };
    await settings.refreshRootSettings();
    expect(JSON.parse(storage?.getItem(key) ?? "null")).toEqual({
      s1: { workingDir: "C:/c" },
    });
  });

  it("rereads manual file edits before the next effective-settings read", async () => {
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    disk = { "style-guidelines": { prompt: "Edited in a text editor" } };
    expect(await settings.readEffectiveSettings()).toEqual(disk);
  });
});
