import { describe, expect, it } from "vitest";

import {
  appliesToProject,
  entriesForProject,
  MAX_MEMORY_TEXT,
  normalizeMemoryText,
  sameMemoryText,
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
