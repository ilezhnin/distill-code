import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "./memoryEntry";
import { MEMORY_FENCE_TAG } from "./memoryFence";
import {
  composeMemorySection,
  formatMemoryPrompt,
  MAX_MEMORY_PROMPT_CHARS,
} from "./memoryPrompt";

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("formatMemoryPrompt", () => {
  it("says nothing when nothing is remembered", () => {
    // An empty <memory> section reads as an invitation to fill it.
    expect(formatMemoryPrompt([], "p-1")).toBeUndefined();
    expect(
      formatMemoryPrompt(
        [entry({ id: "p", scope: "project", projectId: "other" })],
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
    expect(formatMemoryPrompt(entries, null)).toBe(
      formatMemoryPrompt([...entries].reverse(), null),
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

    const prompt = formatMemoryPrompt(entries, null) ?? "";
    expect(prompt.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 500);
    // Newest survives, oldest is the one left out.
    expect(prompt).toContain("- 59 ");
    expect(prompt).not.toContain("- 0 ");
  });
});

describe("composeMemorySection", () => {
  it("always tells a writing agent how to remember, even with nothing on file", () => {
    const section = composeMemorySection([], null, true);
    expect(section).toContain(MEMORY_FENCE_TAG);
    expect(section).not.toContain("<memory>");
  });

  it("puts what is known ahead of how to add to it", () => {
    const section =
      composeMemorySection([entry({ id: "g" })], null, true) ?? "";
    expect(section.indexOf("<memory>")).toBeLessThan(
      section.indexOf("<memory-protocol>"),
    );
  });

  it("gives a read-only session the facts without the protocol", () => {
    // Teaching a fence the scanner would refuse invites writes into a void.
    const section = composeMemorySection([entry({ id: "g" })], null, false);
    expect(section).toContain("<memory>");
    expect(section).not.toContain("<memory-protocol>");
    expect(section).not.toContain(MEMORY_FENCE_TAG);
  });

  it("says nothing at all to a read-only session with nothing on file", () => {
    expect(composeMemorySection([], null, false)).toBeUndefined();
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

    const prompt = formatMemoryPrompt(entries, null) ?? "";
    expect(prompt).toContain("standing");
  });
});
