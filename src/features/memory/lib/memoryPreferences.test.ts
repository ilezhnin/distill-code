import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "./memoryEntry";
import {
  composeGatedMemorySection,
  getMemoryPreferences,
  MEMORY_PREFERENCES_STORAGE_KEY,
  MEMORY_PREFERENCES_STORAGE_VERSION,
  setMemoryReadEnabled,
  setMemoryWriteEnabled,
} from "./memoryPreferences";

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
    expect(getMemoryPreferences()).toEqual({
      write: true,
      read: true,
      wikiGraph: false,
    });
  });
});

describe("composeGatedMemorySection", () => {
  beforeEach(() => {
    window.localStorage.clear();
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
});
