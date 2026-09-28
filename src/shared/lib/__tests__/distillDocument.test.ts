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
  distillDocument,
  openDistillDocumentCountForTests,
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
    await vi.advanceTimersByTimeAsync(0);

    // The second write waits for the first to settle.
    expect(started).toEqual([JSON.stringify({ version: 1, items: ["v1"] })]);

    finishers.shift()?.();
    await first;
    await vi.advanceTimersByTimeAsync(0);

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

  describe("change notices", () => {
    function recognizingDoc() {
      return distillDocument<Doc>({
        path: "memory.json",
        legacyStorageKey: "distill:memory",
        parse: (raw) => ({ items: (raw as Doc).items }),
        serialize: (value) => ({ version: 1, items: value.items }),
        recognizeOwnWrites: true,
      });
    }

    let disk: string | null;

    beforeEach(() => {
      disk = null;
      mocks.readDistillDocument.mockImplementation(async () => disk);
      mocks.writeDistillDocument.mockImplementation(
        async (_path: string, contents: string) => {
          disk = contents;
        },
      );
    });

    it("skips this instance's own write coming back", async () => {
      const document = recognizingDoc();
      document.write({ items: ["mine"] });
      await document.flush();

      await expect(document.readExternal()).resolves.toBeUndefined();
      // A second notice for the same text is still recognized.
      await expect(document.readExternal()).resolves.toBeUndefined();
    });

    it("recognizes an older own write that the notice brings back late", async () => {
      const document = recognizingDoc();
      document.write({ items: ["v1"] });
      await document.flush();
      const v1 = disk;
      document.write({ items: ["v2"] });
      await document.flush();

      // The read after the first notice lands before the second write does.
      disk = v1;
      await expect(document.readExternal()).resolves.toBeUndefined();
    });

    it("reads another window's write", async () => {
      const document = recognizingDoc();
      document.write({ items: ["mine"] });
      await document.flush();

      disk = JSON.stringify({ version: 1, items: ["theirs"] });
      await expect(document.readExternal()).resolves.toEqual({
        items: ["theirs"],
      });
    });

    it("reads everything when it was not asked to recognize its writes", async () => {
      const document = doc();
      document.write({ items: ["mine"] });
      await document.flush();

      await expect(document.readExternal()).resolves.toEqual({
        items: ["mine"],
      });
    });
  });

  it("flushes and stops tracking a disposed document", async () => {
    const before = openDistillDocumentCountForTests();
    const document = doc();
    expect(openDistillDocumentCountForTests()).toBe(before + 1);
    document.write({ items: ["final"] });

    await document.dispose();

    expect(openDistillDocumentCountForTests()).toBe(before);
    expect(mocks.writeDistillDocument).toHaveBeenCalledWith(
      "memory.json",
      JSON.stringify({ version: 1, items: ["final"] }),
    );
  });

  it("retains a failed save and retries it without another edit", async () => {
    const document = doc();
    mocks.writeDistillDocument.mockRejectedValueOnce(new Error("disk full"));
    document.write({ items: ["keep this memory"] });
    await expect(document.flush()).rejects.toThrow("disk full");
    await document.flush();
    expect(mocks.writeDistillDocument).toHaveBeenLastCalledWith(
      "memory.json",
      JSON.stringify({ version: 1, items: ["keep this memory"] }),
    );
    expect(mocks.writeDistillDocument).toHaveBeenCalledTimes(2);
    await document.dispose();
  });

  it("a failed older write never replaces a newer pending value", async () => {
    let rejectWrite: (error: Error) => void = () => {};
    mocks.writeDistillDocument.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectWrite = reject;
        }),
    );
    const document = doc();
    document.write({ items: ["old"] });
    const first = document.flush();
    const failed = expect(first).rejects.toThrow("disk full");
    await vi.advanceTimersByTimeAsync(0);
    document.write({ items: ["new"] });
    rejectWrite(new Error("disk full"));
    await failed;
    await document.flush();
    expect(mocks.writeDistillDocument).toHaveBeenLastCalledWith(
      "memory.json",
      JSON.stringify({ version: 1, items: ["new"] }),
    );
    await document.dispose();
  });
});
