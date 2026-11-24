import { describe, expect, it } from "vitest";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import {
  formatRecallAnswer,
  parseRecallFence,
  recallReachable,
} from "./memoryRecall";

describe("parseRecallFence", () => {
  const block = ["```distill-recall", '{"query":"release branch"}', "```"];

  it("reads the question a reply asks in a block of its own", () => {
    expect(parseRecallFence(["Checking.", ...block].join("\n"))).toEqual({
      query: "release branch",
      scope: "all",
      limit: 5,
    });
  });

  it("asks nothing with a block the reply only quoted or hid", () => {
    for (const quoted of [
      ["````", ...block, "````"],
      block.map((line) => `> ${line}`),
      ["<!--", ...block, "-->"],
      [`The page said ${block.join(" ")} and more.`],
      ['```distill-recall {"query":"inline"}```'],
    ]) {
      expect(parseRecallFence(quoted.join("\n"))).toBeNull();
    }
  });
});

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: Date.UTC(2026, 0, 2),
    ...overrides,
  };
}

function archivedEntry(
  overrides: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(overrides),
    archivedAt: Date.UTC(2026, 5, 1),
    archiveReason: "capacity",
    ...overrides,
  };
}

describe("recallReachable", () => {
  const entries = [
    entry({ id: "g", text: "Global fact" }),
    entry({ id: "mine", text: "Mine", scope: "project", projectId: "p-1" }),
    entry({ id: "theirs", text: "Theirs", scope: "project", projectId: "p-2" }),
  ];

  it("never reaches into another project", () => {
    // LAWS/MEMORY.md, Reading back: crossing projects is the operator's search.
    expect(recallReachable(entries, "p-1", "all").map((e) => e.id)).toEqual([
      "g",
      "mine",
    ]);
  });

  it("gates the archive the same way", () => {
    const archive = [
      archivedEntry({ id: "a-mine", scope: "project", projectId: "p-1" }),
      archivedEntry({ id: "a-theirs", scope: "project", projectId: "p-2" }),
    ];
    expect(recallReachable(archive, "p-1", "all").map((e) => e.id)).toEqual([
      "a-mine",
    ]);
  });

  it("gives a session with no project only the global list", () => {
    expect(recallReachable(entries, null, "all").map((e) => e.id)).toEqual([
      "g",
    ]);
  });
});

describe("formatRecallAnswer", () => {
  const projectNameOf = (id: string | null) => (id === "p-1" ? "Flock" : "?");

  it("keeps a quoted question from breaking the header", () => {
    const answer = formatRecallAnswer(
      [],
      projectNameOf,
      'the "release"\n  branch',
    );
    expect(answer.split("\n")[0]).toBe(
      "<memory-recall query=\"the 'release' branch\">",
    );
  });
});
