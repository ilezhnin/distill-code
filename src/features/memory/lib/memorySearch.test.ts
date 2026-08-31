import { describe, expect, it } from "vitest";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import { memorySearchTerms, searchMemories } from "./memorySearch";

function entry(over: Partial<MemoryEntry> & { text: string }): MemoryEntry {
  return {
    id: over.text,
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...over,
  };
}

describe("memorySearchTerms", () => {
  it("keeps the shapes facts are actually written in", () => {
    expect(memorySearchTerms("the branch is release/2026.9!")).toEqual([
      "the",
      "branch",
      "is",
      "release/2026.9",
    ]);
  });

  it("has no terms for a query of punctuation", () => {
    expect(memorySearchTerms("  ??  ")).toEqual([]);
  });
});

function archivedEntry(
  over: Partial<ArchivedMemoryEntry> & { text: string },
): ArchivedMemoryEntry {
  return {
    ...entry(over),
    archivedAt: 0,
    archiveReason: "capacity",
    ...over,
  };
}

describe("searchMemories", () => {
  const entries = [
    entry({ text: "The release branch is release/2026.9", createdAt: 1 }),
    entry({
      text: "Release notes are written by the marketer",
      createdAt: 100,
    }),
    entry({ text: "Ivan reviews Rust changes himself", createdAt: 50 }),
  ];

  it("matches nothing on an empty query rather than everything", () => {
    // The page already shows the full list; a search box that matches all
    // three hundred rows the moment it is focused is not a search.
    expect(searchMemories(entries, "   ")).toEqual([]);
  });

  it("finds a fact by any word in it", () => {
    const hits = searchMemories(entries, "rust");
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.text).toContain("Rust");
  });

  it("puts the phrase match above the more recent partial one", () => {
    // Recency decides what is shown by default. Once a question has been
    // asked, how well the answer fits it is the better signal.
    const hits = searchMemories(entries, "release branch");
    expect(hits[0].entry.text).toBe("The release branch is release/2026.9");
    expect(hits[0].phrase).toBe(true);
    expect(hits[1].entry.text).toContain("Release notes");
  });

  it("finds a fact the prompt block would have dropped", () => {
    // The whole point: the block is capped and recency-ordered, so an old
    // fact that is still true is not in it. It is still in the store.
    const ancient = entry({
      text: "The Unity project lives in E:/Unity/quarp",
      createdAt: -10_000_000,
    });
    const hits = searchMemories([...entries, ancient], "unity");
    expect(hits[0].entry).toBe(ancient);
  });

  it("searches across projects, because the answer may be in another one", () => {
    const scoped = entry({
      text: "Migrations run before the deploy",
      scope: "project",
      projectId: "p-other",
      createdAt: 5,
    });
    expect(searchMemories([...entries, scoped], "migrations")[0].entry).toBe(
      scoped,
    );
  });

  it("honours a limit", () => {
    expect(searchMemories(entries, "the", { limit: 1 })).toHaveLength(1);
  });
});

describe("searchMemories over the archive", () => {
  const live = [entry({ text: "The release branch is main", createdAt: 10 })];
  const archive = [
    archivedEntry({
      text: "The release branch is release/2026.8",
      createdAt: 20,
      archivedAt: 30,
      archiveReason: "superseded",
    }),
  ];

  it("leaves the archive alone unless the caller passes it", () => {
    // Searching the panel's list must not start answering with lines the app
    // has stopped standing behind.
    const hits = searchMemories(live, "2026.8");
    expect(hits).toEqual([]);
  });

  it("finds a displaced memory and says it is archived", () => {
    const hits = searchMemories(live, "2026.8", { archived: archive });
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.text).toContain("release/2026.8");
    expect(hits[0].archived).toBe(true);
  });

  it("puts the live memory above the archived one at the same rank", () => {
    // The archived line is the more recent of the two; still, what the app
    // stands behind today answers first.
    const hits = searchMemories(live, "release branch", {
      archived: archive,
    });
    expect(hits.map((hit) => Boolean(hit.archived))).toEqual([false, true]);
    expect(hits[0].archived).toBeUndefined();
  });

  it("still ranks a better match first, archived or not", () => {
    const hits = searchMemories(
      [entry({ text: "The branch", createdAt: 100 })],
      "release branch",
      { archived: archive },
    );
    expect(hits[0].archived).toBe(true);
    expect(hits[0].matched).toEqual(["release", "branch"]);
  });

  it("honours a limit across both lists", () => {
    expect(
      searchMemories(live, "release", { archived: archive, limit: 1 }),
    ).toHaveLength(1);
  });
});
