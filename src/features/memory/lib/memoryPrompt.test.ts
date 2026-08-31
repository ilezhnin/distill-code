import { describe, expect, it } from "vitest";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import { MEMORY_FENCE_TAG } from "./memoryFence";
import {
  archivedCountForProject,
  composeMemorySection,
  formatMemoryPrompt,
  MAX_MEMORY_PROMPT_CHARS,
  selectPromptEntries,
} from "./memoryPrompt";
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

function archived(
  overrides: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(overrides),
    archivedAt: 0,
    archiveReason: "capacity",
    ...overrides,
  };
}

describe("formatMemoryPrompt", () => {
  it("says nothing when nothing is remembered", () => {
    // An empty <memory> section reads as an invitation to fill it.
    expect(formatMemoryPrompt([], 0, "p-1")).toBeUndefined();
    expect(
      formatMemoryPrompt(
        [entry({ id: "p", scope: "project", projectId: "other" })],
        0,
        "p-1",
      ),
    ).toBeUndefined();
  });

  it("lists what applies to this project", () => {
    const prompt = formatMemoryPrompt(
      [
        entry({ id: "g", text: "Ivan reviews Rust himself" }),
        entry({
          id: "p",
          text: "The release branch is release/2026.9",
          scope: "project",
          projectId: "p-1",
          createdAt: 1,
        }),
        entry({
          id: "x",
          text: "A different codebase",
          scope: "project",
          projectId: "p-2",
        }),
      ],
      0,
      "p-1",
    );

    expect(prompt).toContain("- Ivan reviews Rust himself");
    expect(prompt).toContain("- The release branch is release/2026.9");
    expect(prompt).not.toContain("A different codebase");
  });

  it("is byte-identical between two calls on the same list", () => {
    // The block heads a cached prompt; a reshuffle costs a cache miss per send.
    const entries = [
      entry({ id: "b", createdAt: 2 }),
      entry({ id: "a", createdAt: 1 }),
    ];
    expect(formatMemoryPrompt(entries, 0, null)).toBe(
      formatMemoryPrompt([...entries].reverse(), 0, null),
    );
  });

  it("drops the oldest lines rather than blowing the budget", () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry({
        id: `e-${index}`,
        text: `${index} ${"y".repeat(120)}`,
        createdAt: index,
      }),
    );

    const prompt = formatMemoryPrompt(entries, 0, null) ?? "";
    expect(prompt.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 500);
    // Newest survives, oldest is the one left out.
    expect(prompt).toContain("- 59 ");
    expect(prompt).not.toContain("- 0 ");
  });
});

describe("composeMemorySection", () => {
  it("always tells a writing agent how to remember, even with nothing on file", () => {
    const section = composeMemorySection([], 0, null, true);
    expect(section).toContain(MEMORY_FENCE_TAG);
    expect(section).not.toContain("<memory>");
  });

  it("puts what is known ahead of how to add to it", () => {
    const section =
      composeMemorySection([entry({ id: "g" })], 0, null, true) ?? "";
    expect(section.indexOf("<memory>")).toBeLessThan(
      section.indexOf("<memory-protocol>"),
    );
  });

  it("gives a read-only session the facts without the protocol", () => {
    // Teaching a fence the scanner would refuse invites writes into a void.
    const section = composeMemorySection([entry({ id: "g" })], 0, null, false);
    expect(section).toContain("<memory>");
    expect(section).not.toContain("<memory-protocol>");
    expect(section).not.toContain(MEMORY_FENCE_TAG);
  });

  it("says nothing at all to a read-only session with nothing on file", () => {
    expect(composeMemorySection([], 0, null, false)).toBeUndefined();
  });

  it("teaches recall to everyone carrying the block, read-only included", () => {
    // Recall is a read; the ACL it answers to is the project reach, not the
    // write grant (LAWS/MEMORY.md, Reading back).
    for (const writeAllowed of [true, false]) {
      const section =
        composeMemorySection([entry({ id: "g" })], 0, null, writeAllowed) ?? "";
      expect(section).toContain("<memory-recall-protocol>");
      expect(section.indexOf("<memory>")).toBeLessThan(
        section.indexOf("<memory-recall-protocol>"),
      );
    }
  });

  it("does not teach recall where there is no block to supplement", () => {
    const section = composeMemorySection([], 0, null, true) ?? "";
    expect(section).not.toContain("<memory-recall-protocol>");
  });
});

describe("the line pointing past the block", () => {
  function crowded(): MemoryEntry[] {
    return Array.from({ length: 60 }, (_, index) =>
      entry({
        id: `e-${index}`,
        text: `${index} ${"y".repeat(120)}`,
        createdAt: index,
      }),
    );
  }

  it("says nothing when the block already carries everything", () => {
    const prompt = formatMemoryPrompt([entry({ id: "g" })], 0, null) ?? "";
    expect(prompt).not.toContain("beyond this block");
  });

  it("counts what the budget left out and what the archive holds", () => {
    const prompt = formatMemoryPrompt(crowded(), 4, null) ?? "";
    const line = prompt
      .split("\n")
      .find((row) => row.includes("beyond this block"));
    const [, beyond, stored] =
      line?.match(
        /…and (\d+) older memories are stored beyond this block \((\d+) archived\)/,
      ) ?? [];
    expect(Number(stored)).toBe(4);
    // Everything reachable that the block could not carry, archive included.
    expect(Number(beyond)).toBeGreaterThan(4);
    expect(line).toContain(`Ask with the ${RECALL_FENCE_TAG} fence.`);
  });

  it("points at the fence when only the archive is behind the block", () => {
    const prompt = formatMemoryPrompt([entry({ id: "g" })], 3, null) ?? "";
    expect(prompt).toContain(
      `…and 3 older memories are stored beyond this block (3 archived). Ask with the ${RECALL_FENCE_TAG} fence.`,
    );
  });

  it("goes last, so the lines above it stay where the cache saw them", () => {
    const rows = (formatMemoryPrompt(crowded(), 4, null) ?? "").split("\n");
    expect(rows.at(-1)).toBe("</memory>");
    expect(rows.at(-2)).toContain("beyond this block");
    expect(rows.at(-3)).toMatch(/^- /);

    // Everything before it is byte-identical to the block without it: the
    // block heads a cached prompt, and only the tail may move.
    const entries = [entry({ id: "g" })];
    const quiet = formatMemoryPrompt(entries, 0, null) ?? "";
    const pointing = formatMemoryPrompt(entries, 3, null) ?? "";
    expect(
      pointing.startsWith(quiet.slice(0, quiet.lastIndexOf("</memory>"))),
    ).toBe(true);
  });
});

describe("archivedCountForProject", () => {
  it("counts only the archive this session may be told about", () => {
    const archive = [
      archived({ id: "g" }),
      archived({ id: "mine", scope: "project", projectId: "p-1" }),
      archived({ id: "theirs", scope: "project", projectId: "p-2" }),
    ];
    expect(archivedCountForProject(archive, "p-1")).toBe(2);
    expect(archivedCountForProject(archive, null)).toBe(1);
  });
});

describe("memory prompt recency", () => {
  it("keeps a restated old fact over a newer one nobody has confirmed", () => {
    // Recency, not age: the agents restating a fact is what makes it live.
    const filler = "z".repeat(200);
    const entries = [
      entry({
        id: "old-but-live",
        text: `standing ${filler}`,
        createdAt: 1,
        reinforcedAt: 10_000,
      }),
      ...Array.from({ length: 40 }, (_, index) =>
        entry({
          id: `newer-${index}`,
          text: `${index} ${filler}`,
          createdAt: 100 + index,
        }),
      ),
    ];

    const prompt = formatMemoryPrompt(entries, 0, null) ?? "";
    expect(prompt).toContain("standing");
  });
});

describe("the block as the provider's cache sees it", () => {
  it("is byte-for-byte what it has always been on a non-trivial store", () => {
    // A golden copy of the block, written out here rather than derived from
    // the code that builds it: the block heads a cached prompt, so any change
    // to its wording, order or spacing is a cache miss on every send and has
    // to be a decision, not a side effect of a refactor.
    const filler = "y".repeat(1200);
    const alpha = `alpha ${filler}`;
    const beta = `beta ${filler}`;
    const gamma = `gamma ${filler}`;
    const delta = `delta ${filler}`;

    const prompt = formatMemoryPrompt(
      [
        entry({ id: "g-alpha", text: alpha, createdAt: 1 }),
        entry({ id: "g-beta", text: beta, createdAt: 5 }),
        entry({
          id: "p-gamma",
          text: gamma,
          scope: "project",
          projectId: "p-1",
          createdAt: 2,
        }),
        entry({
          id: "p-delta",
          text: delta,
          scope: "project",
          projectId: "p-1",
          createdAt: 9,
          reinforcedAt: 10_000,
        }),
        entry({
          id: "x",
          text: "Another codebase entirely",
          scope: "project",
          projectId: "p-2",
          createdAt: 3,
        }),
      ],
      1,
      "p-1",
    );

    expect(prompt).toBe(
      [
        "<memory>",
        "Facts the operator has kept from earlier sessions. Treat them as true unless this conversation shows otherwise — and when it does, say so and correct the record with the protocol below.",
        "",
        `- ${beta}`,
        `- ${gamma}`,
        `- ${delta}`,
        "…and 2 older memories are stored beyond this block (1 archived). Ask with the distill-recall fence.",
        "</memory>",
      ].join("\n"),
    );
  });
});

describe("selectPromptEntries", () => {
  const shortText = (index: number) =>
    `${String(index).padStart(3, "0")} ${"y".repeat(56)}`;

  function many(): MemoryEntry[] {
    return Array.from({ length: 100 }, (_, index) =>
      entry({ id: `e-${index}`, text: shortText(index), createdAt: index }),
    );
  }

  it("carries what fits and leaves the rest out", () => {
    const entries = many();
    const { ids, usedChars } = selectPromptEntries(entries, null);

    expect(usedChars).toBeLessThanOrEqual(MAX_MEMORY_PROMPT_CHARS);
    // A hundred sixty-character lines do not fit in four thousand characters:
    // the operator has to be able to see that some of them are not carried.
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.size).toBeLessThan(entries.length);
    // The newest are the ones kept, the oldest the ones displaced.
    expect(ids.has("e-99")).toBe(true);
    expect(ids.has("e-0")).toBe(false);
  });

  it("lets a restatement buy an old line its place back", () => {
    const entries = many();
    expect(selectPromptEntries(entries, null).ids.has("e-0")).toBe(false);

    const reinforced = entries.map((candidate) =>
      candidate.id === "e-0"
        ? { ...candidate, reinforcedAt: 10_000 }
        : candidate,
    );
    const before = selectPromptEntries(entries, null);
    const after = selectPromptEntries(reinforced, null);
    expect(after.ids.has("e-0")).toBe(true);
    // It took someone's place rather than growing the block: the same count
    // of lines, and the oldest one that used to fit no longer does.
    expect(after.ids.size).toBe(before.ids.size);
    const oldestCarried = [...entries]
      .filter((candidate) => before.ids.has(candidate.id))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    expect(after.ids.has(oldestCarried.id)).toBe(false);
    expect(after.usedChars).toBeLessThanOrEqual(MAX_MEMORY_PROMPT_CHARS);
  });

  it("answers for the project it was asked about", () => {
    const entries = [
      entry({ id: "g" }),
      entry({ id: "mine", scope: "project", projectId: "p-1" }),
      entry({ id: "theirs", scope: "project", projectId: "p-2" }),
    ];

    expect([...selectPromptEntries(entries, "p-1").ids].sort()).toEqual([
      "g",
      "mine",
    ]);
    expect([...selectPromptEntries(entries, null).ids]).toEqual(["g"]);
  });

  it("is the same selection the block is built from", () => {
    // The panel's badge and the prompt must never disagree about a line.
    const entries = many();
    const prompt = formatMemoryPrompt(entries, 0, null) ?? "";
    const { ids } = selectPromptEntries(entries, null);
    for (const candidate of entries) {
      expect(prompt.includes(`- ${candidate.text}`)).toBe(
        ids.has(candidate.id),
      );
    }
  });
});
