import { describe, expect, it } from "vitest";

import {
  appliesToProject,
  entriesForProject,
  isArchiveOverfull,
  isMemoryArchiveReason,
  MAX_ARCHIVED_ENTRIES,
  MAX_MEMORY_TEXT,
  MEMORY_ARCHIVE_REASONS,
  normalizeMemoryText,
  sameMemoryText,
  type ArchivedMemoryEntry,
  type MemoryEntry,
} from "./memoryEntry";

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("normalizeMemoryText", () => {
  it("collapses a memory to one line", () => {
    expect(normalizeMemoryText("  two\n\nlines   here ")).toBe(
      "two lines here",
    );
  });

  it("cuts an over-long memory rather than dropping it", () => {
    const long = "x".repeat(MAX_MEMORY_TEXT + 50);
    const normalized = normalizeMemoryText(long);
    expect(normalized).toHaveLength(MAX_MEMORY_TEXT);
    expect(normalized.endsWith("…")).toBe(true);
  });
});

describe("sameMemoryText", () => {
  it("reads the way a person would", () => {
    expect(sameMemoryText(" The Branch is main ", "the branch is main")).toBe(
      true,
    );
    expect(sameMemoryText("branch is main", "branch is next")).toBe(false);
  });
});

describe("appliesToProject", () => {
  it("lets a global fact into every project", () => {
    expect(appliesToProject(entry({ id: "g" }), "p-1")).toBe(true);
    expect(appliesToProject(entry({ id: "g" }), null)).toBe(true);
  });

  it("keeps a project fact inside its project", () => {
    const scoped = entry({ id: "p", scope: "project", projectId: "p-1" });
    expect(appliesToProject(scoped, "p-1")).toBe(true);
    expect(appliesToProject(scoped, "p-2")).toBe(false);
    expect(appliesToProject(scoped, null)).toBe(false);
  });
});

describe("entriesForProject", () => {
  it("puts global facts first and keeps a stable order", () => {
    const entries = [
      entry({ id: "b", createdAt: 2 }),
      entry({ id: "p2", scope: "project", projectId: "p-1", createdAt: 4 }),
      entry({ id: "a", createdAt: 1 }),
      entry({ id: "p1", scope: "project", projectId: "p-1", createdAt: 3 }),
      entry({ id: "other", scope: "project", projectId: "p-9", createdAt: 0 }),
    ];

    expect(entriesForProject(entries, "p-1").map((e) => e.id)).toEqual([
      "a",
      "b",
      "p1",
      "p2",
    ]);
  });

  it("gives a projectless session only what applies everywhere", () => {
    const entries = [
      entry({ id: "g" }),
      entry({ id: "p", scope: "project", projectId: "p-1" }),
    ];
    expect(entriesForProject(entries, null).map((e) => e.id)).toEqual(["g"]);
  });
});

describe("the archive contract", () => {
  it("names every way a memory can leave the live list", () => {
    expect([...MEMORY_ARCHIVE_REASONS]).toEqual([
      "capacity",
      "forgotten",
      "superseded",
    ]);
  });

  it("reads a reason a stored document may not have", () => {
    expect(isMemoryArchiveReason("forgotten")).toBe(true);
    expect(isMemoryArchiveReason("deleted")).toBe(false);
    expect(isMemoryArchiveReason(undefined)).toBe(false);
  });

  it("holds room for far more displacements than live memories", () => {
    // The bound exists because the archive is written to disk, not because
    // the app wants to be rid of what it displaced.
    expect(MAX_ARCHIVED_ENTRIES).toBe(2000);
  });

  it("calls the archive full one past the bound, and never trims it", () => {
    // The bound is a line the panel says out loud, not one the store cuts on:
    // clearing the archive out is the operator's action, and only theirs
    // (LAWS/MEMORY.md, Sovereignty).
    expect(isArchiveOverfull(0)).toBe(false);
    expect(isArchiveOverfull(MAX_ARCHIVED_ENTRIES)).toBe(false);
    expect(isArchiveOverfull(MAX_ARCHIVED_ENTRIES + 1)).toBe(true);
  });

  it("keeps an archived memory usable as the memory it was", () => {
    // It extends `MemoryEntry`, so scope still decides who may read it back.
    const archived: ArchivedMemoryEntry = {
      ...entry({ id: "a", scope: "project", projectId: "p-1" }),
      archivedAt: 10,
      archiveReason: "capacity",
    };
    expect(appliesToProject(archived, "p-1")).toBe(true);
    expect(appliesToProject(archived, "p-2")).toBe(false);
  });
});
