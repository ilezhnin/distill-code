import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const projectRead = vi.hoisted(() => vi.fn());
const projectInit = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/distillStore", () => ({ readDistillDocument: read }));
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

describe("Distill root settings", () => {
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
    settings.getPreferenceStorage()?.setItem("distill:locale", "es");
    await settings.flushRootSettings();
    resolveRead('{"locale":"en"}');
    await refresh;
    expect(settings.getPreferenceStorage()?.getItem("distill:locale")).toBe(
      "es",
    );
    expect(disk.locale).toBe("es");
  });
  it("migrates browser preferences once, preserving disk values and UI state", async () => {
    disk = { locale: "es", custom: { retained: true } };
    localStorage.setItem("distill:locale", "en");
    localStorage.setItem("distill:notifications", '{"enabled":false}');
    localStorage.setItem("distill:sidebar:layout", "unchanged");
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    expect(disk).toEqual({
      locale: "es",
      custom: { retained: true },
      notifications: { enabled: false },
    });
    expect(settings.getPreferenceStorage()?.getItem("distill:locale")).toBe(
      "es",
    );
    expect(localStorage.getItem("distill:notifications")).toBeNull();
    expect(localStorage.getItem("distill:sidebar:layout")).toBe("unchanged");
    await settings.initializeRootSettings();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser copy when migration fails and retries on the next start attempt", async () => {
    localStorage.setItem("distill:locale", "es");
    update.mockRejectedValueOnce(new Error("disk unavailable"));
    const settings = await import("./rootSettings");
    await expect(settings.initializeRootSettings()).rejects.toThrow(
      "disk unavailable",
    );
    expect(localStorage.getItem("distill:locale")).toBe("es");
    await settings.initializeRootSettings();
    expect(disk.locale).toBe("es");
    expect(localStorage.getItem("distill:locale")).toBeNull();
  });

  it("does not overwrite malformed operator settings", async () => {
    localStorage.setItem("distill:locale", "es");
    read.mockResolvedValueOnce("not JSON");
    const settings = await import("./rootSettings");
    await expect(settings.initializeRootSettings()).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(localStorage.getItem("distill:locale")).toBe("es");
  });

  it("writes only changed keys and keeps an unrelated edit from another window", async () => {
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    disk.locale = "es";
    settings
      .getPreferenceStorage()
      ?.setItem("distill:notifications", '{"enabled":false}');
    await settings.flushRootSettings();
    expect(disk).toEqual({ locale: "es", notifications: { enabled: false } });
    expect(localStorage.getItem("distill:notifications")).toBeNull();
  });

  it("retries failed writes without dropping earlier changed keys", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    update.mockRejectedValueOnce(new Error("offline"));
    settings.getPreferenceStorage()?.setItem("distill:locale", "es");
    await expect(settings.flushRootSettings()).rejects.toThrow("offline");
    settings
      .getPreferenceStorage()
      ?.setItem("distill:notifications", '{"enabled":false}');
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

  it("rereads manual file edits before the next effective-settings read", async () => {
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    disk = { "style-guidelines": { prompt: "Edited in a text editor" } };
    expect(await settings.readEffectiveSettings()).toEqual(disk);
  });

  it("keeps browser previews on localStorage with no native traffic", async () => {
    delete window.__TAURI_INTERNALS__;
    const settings = await import("./rootSettings");
    await settings.initializeRootSettings();
    settings.getPreferenceStorage()?.setItem("distill:locale", "es");
    expect(localStorage.getItem("distill:locale")).toBe("es");
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
