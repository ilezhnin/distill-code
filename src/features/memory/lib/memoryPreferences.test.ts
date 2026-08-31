import { beforeEach, describe, expect, it, vi } from "vitest";

import { MEMORY_FENCE_TAG } from "./memoryFence";
import type { MemoryEntry } from "./memoryEntry";
import {
  composeGatedMemorySection,
  getMemoryPreferences,
  MEMORY_PREFERENCES_CHANGE_EVENT,
  MEMORY_PREFERENCES_STORAGE_KEY,
  MEMORY_PREFERENCES_STORAGE_VERSION,
  setMemoryReadEnabled,
  setMemoryWriteEnabled,
  subscribeToMemoryPreferenceChanges,
} from "./memoryPreferences";
import { RECALL_FENCE_TAG } from "./memoryRecall";

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("memoryPreferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("carries memory both ways until the operator says otherwise", () => {
    expect(getMemoryPreferences()).toEqual({ write: true, read: true });
  });

  it("keeps each switch apart from the other", () => {
    setMemoryWriteEnabled(false);
    expect(getMemoryPreferences()).toEqual({ write: false, read: true });

    setMemoryReadEnabled(false);
    expect(getMemoryPreferences()).toEqual({ write: false, read: false });

    setMemoryWriteEnabled(true);
    expect(getMemoryPreferences()).toEqual({ write: true, read: false });
  });

  it("stores what it read back", () => {
    setMemoryWriteEnabled(false);
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(MEMORY_PREFERENCES_STORAGE_KEY) ?? "null",
    );
    expect(stored).toMatchObject({
      version: MEMORY_PREFERENCES_STORAGE_VERSION,
      write: false,
    });
  });

  it("announces a change so every send path sees the same switch", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToMemoryPreferenceChanges(listener);

    setMemoryReadEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setMemoryReadEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("falls back to both on when the stored record is unreadable", () => {
    window.localStorage.setItem(MEMORY_PREFERENCES_STORAGE_KEY, "{not json");
    expect(getMemoryPreferences()).toEqual({ write: true, read: true });
  });

  it("refuses to write over a record a newer build left", () => {
    // Half-reading a future schema could switch memory back on behind the
    // operator, which is the one failure this record must not have.
    const future = JSON.stringify({
      version: MEMORY_PREFERENCES_STORAGE_VERSION + 1,
      write: false,
      read: false,
    });
    window.localStorage.setItem(MEMORY_PREFERENCES_STORAGE_KEY, future);

    expect(setMemoryWriteEnabled(true)).toBe(false);
    expect(window.localStorage.getItem(MEMORY_PREFERENCES_STORAGE_KEY)).toBe(
      future,
    );
    // Unreadable here, so this build treats it as the default rather than
    // acting on a version it does not understand.
    expect(getMemoryPreferences()).toEqual({ write: true, read: true });
  });

  it("does not leave a stale change event behind a refused write", () => {
    window.localStorage.setItem(
      MEMORY_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: MEMORY_PREFERENCES_STORAGE_VERSION + 1 }),
    );
    const listener = vi.fn();
    window.addEventListener(MEMORY_PREFERENCES_CHANGE_EVENT, listener);

    expect(setMemoryReadEnabled(false)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener(MEMORY_PREFERENCES_CHANGE_EVENT, listener);
  });
});

describe("composeGatedMemorySection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("composes the section exactly as before while reading is on", () => {
    const section =
      composeGatedMemorySection(
        getMemoryPreferences(),
        [entry({ id: "g" })],
        0,
        null,
        true,
      ) ?? "";
    expect(section).toContain("A fact");
    expect(section).toContain(MEMORY_FENCE_TAG);
    expect(section).toContain(RECALL_FENCE_TAG);
  });

  it("takes out the block and both protocols when reading is off", () => {
    setMemoryReadEnabled(false);
    // Not just the facts: the write fence and the recall fence ride inside
    // the same section, and a session taught to ask for memories that will
    // never be mixed in has been promised an answer.
    expect(
      composeGatedMemorySection(
        getMemoryPreferences(),
        [entry({ id: "g" })],
        3,
        null,
        true,
      ),
    ).toBeUndefined();
  });

  it("still says nothing when reading is off and this session may not write", () => {
    setMemoryReadEnabled(false);
    expect(
      composeGatedMemorySection(
        getMemoryPreferences(),
        [entry({ id: "g" })],
        0,
        null,
        false,
      ),
    ).toBeUndefined();
  });

  it("does not care about the write switch — that one is enforced at the drain", () => {
    setMemoryWriteEnabled(false);
    const section =
      composeGatedMemorySection(
        getMemoryPreferences(),
        [entry({ id: "g" })],
        0,
        null,
        true,
      ) ?? "";
    expect(section).toContain("A fact");
  });
});
