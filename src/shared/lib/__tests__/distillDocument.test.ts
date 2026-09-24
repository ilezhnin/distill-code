/**
 * The document layer, tested where it actually bites: the desktop path, where
 * a document lives in a folder and an old browser copy has to be moved into it
 * exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(() => true),
  readDistillDocument: vi.fn(async (_path: string) => null as string | null),
  writeDistillDocument: vi.fn(async (_path: string, _contents: string) => {}),
}));

vi.mock("@/shared/api/distillStore", () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
  readDistillDocument: mocks.readDistillDocument,
  writeDistillDocument: mocks.writeDistillDocument,
}));

import {
  corruptCopyPath,
  DISTILL_WRITE_DEBOUNCE_MS,
  distillDocument,
} from "../distillDocument";

interface Doc {
  items: string[];
}

function doc() {
  return distillDocument<Doc>({
    path: "memory.json",
    legacyStorageKey: "distill:memory",
    // Salvaging: anything unreadable becomes an empty list, never a throw.
    parse: (raw) => ({
      items: Array.isArray((raw as Doc | null)?.items)
        ? (raw as Doc).items.filter((i): i is string => typeof i === "string")
        : [],
    }),
    serialize: (value) => ({ version: 1, items: value.items }),
  });
}

describe("distillDocument on the desktop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    mocks.isDesktopRuntime.mockReturnValue(true);
    mocks.readDistillDocument.mockResolvedValue(null);
    mocks.writeDistillDocument.mockClear();
    mocks.writeDistillDocument.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads what is stored in the folder", async () => {
    mocks.readDistillDocument.mockResolvedValue('{"items":["a","b"]}');

    await expect(doc().read()).resolves.toEqual({ items: ["a", "b"] });
  });

  it("is empty when nothing has been written and nothing was inherited", async () => {
    await expect(doc().read()).resolves.toBeNull();
  });

  it("moves an old browser copy into the folder, once", async () => {
    window.localStorage.setItem(
      "distill:memory",
      JSON.stringify({ items: ["inherited"] }),
    );

    const value = await doc().read();

    expect(value).toEqual({ items: ["inherited"] });
    expect(mocks.writeDistillDocument).toHaveBeenCalledWith(
      "memory.json",
      JSON.stringify({ version: 1, items: ["inherited"] }),
    );
    // Removed, so a later reinstall cannot resurrect a stale second copy.
    expect(window.localStorage.getItem("distill:memory")).toBeNull();
  });

  it("keeps the browser copy when the move fails", async () => {
    // Dropping it would lose the data outright.
    window.localStorage.setItem("distill:memory", '{"items":["fragile"]}');
    mocks.writeDistillDocument.mockRejectedValue(new Error("read-only"));

    await expect(doc().read()).resolves.toEqual({ items: ["fragile"] });
    expect(window.localStorage.getItem("distill:memory")).not.toBeNull();
  });

  it("prefers the folder over an old browser copy", async () => {
    mocks.readDistillDocument.mockResolvedValue('{"items":["current"]}');
    window.localStorage.setItem("distill:memory", '{"items":["stale"]}');

    await expect(doc().read()).resolves.toEqual({ items: ["current"] });
  });

  it("survives a document that is not JSON at all, keeping a copy", async () => {
    mocks.readDistillDocument.mockResolvedValue("}{ broken");

    await expect(doc().read()).resolves.toBeNull();
    // The next write replaces memory.json; the unparseable text is kept.
    expect(mocks.writeDistillDocument).toHaveBeenCalledWith(
      expect.stringMatching(/^memory\.corrupt-\d+\.json$/),
      "}{ broken",
    );
  });

  it("does not start from empty when the corrupt copy cannot be kept", async () => {
    mocks.readDistillDocument.mockResolvedValue("}{ broken");
    mocks.writeDistillDocument.mockRejectedValue(new Error("read-only"));

    await expect(doc().read()).rejects.toThrow("read-only");
  });

  it("rejects when the folder cannot be read, rather than reading empty", async () => {
    // An empty result would let the store's next write replace the file.
    mocks.readDistillDocument.mockRejectedValue(new Error("sharing violation"));
    window.localStorage.setItem("distill:memory", '{"items":["stale"]}');

    await expect(doc().read()).rejects.toThrow("sharing violation");
    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();
  });

  it("names the corrupt copy beside the original", () => {
    expect(corruptCopyPath("memory.json", 42)).toBe("memory.corrupt-42.json");
    expect(corruptCopyPath("conductor/graph.json", 7)).toBe(
      "conductor/graph.corrupt-7.json",
    );
  });

  it("coalesces a burst of writes into one", async () => {
    // Holding a key down must not queue fifty round trips to disk.
    const document = doc();
    document.write({ items: ["a"] });
    document.write({ items: ["a", "b"] });
    document.write({ items: ["a", "b", "c"] });
    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DISTILL_WRITE_DEBOUNCE_MS);

    expect(mocks.writeDistillDocument).toHaveBeenCalledTimes(1);
    expect(mocks.writeDistillDocument).toHaveBeenCalledWith(
      "memory.json",
      JSON.stringify({ version: 1, items: ["a", "b", "c"] }),
    );
  });

  it("flushes a queued write without waiting for the timer", async () => {
    const document = doc();
    document.write({ items: ["closing"] });

    await document.flush();

    expect(mocks.writeDistillDocument).toHaveBeenCalledTimes(1);
  });

  it("does not write again when there is nothing queued", async () => {
    const document = doc();
    await document.flush();
    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();
  });

  it("writes one payload at a time, in the order they were queued", async () => {
    // Two concurrent invokes can finish in either order, and the loser's
    // rename would replace the newer document.
    const started: string[] = [];
    const finishers: (() => void)[] = [];
    mocks.writeDistillDocument.mockImplementation(
      (_path: string, contents: string) => {
        started.push(contents);
        return new Promise<void>((resolve) => {
          finishers.push(() => resolve());
        });
      },
    );

    const document = doc();
    document.write({ items: ["v1"] });
    const first = document.flush();
    document.write({ items: ["v2"] });
    const second = document.flush();
    await Promise.resolve();

    // The second write waits for the first to settle.
    expect(started).toEqual([JSON.stringify({ version: 1, items: ["v1"] })]);

    finishers.shift()?.();
    await first;

    expect(started).toEqual([
      JSON.stringify({ version: 1, items: ["v1"] }),
      JSON.stringify({ version: 1, items: ["v2"] }),
    ]);
    finishers.shift()?.();
    await second;
  });

  it.each([
    "pagehide",
    "beforeunload",
  ])("flushes a debounced write when the window goes away (%s)", async (event) => {
    const document = doc();
    document.write({ items: ["last change"] });
    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();

    window.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.writeDistillDocument).toHaveBeenCalledWith(
      "memory.json",
      JSON.stringify({ version: 1, items: ["last change"] }),
    );
  });

  it("survives a folder it cannot write to", async () => {
    mocks.writeDistillDocument.mockRejectedValue(new Error("disk full"));
    const document = doc();
    document.write({ items: ["a"] });

    // The failure is reported, not thrown at whoever ticked a checkbox.
    await expect(document.flush()).resolves.toBeUndefined();
  });
});

describe("distillDocument outside the desktop app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    mocks.isDesktopRuntime.mockReturnValue(false);
    mocks.writeDistillDocument.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to browser storage and never calls the backend", async () => {
    const document = doc();
    document.write({ items: ["local"] });
    await document.flush();

    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();
    await expect(document.read()).resolves.toEqual({ items: ["local"] });
  });
});
