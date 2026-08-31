import { describe, expect, it, vi } from "vitest";

import type { MemoryEntry } from "./memoryEntry";
import {
  composeReviewMessage,
  MAX_REVIEW_DUMP_CHARS,
  startMemoryReviewChat,
} from "./memoryReview";

const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

/** The panel's own resolver, in the shape the contract asks for: it hands
 *  over names, never the ids the store keys projects by. */
const PROJECT_NAMES: Record<string, string> = {
  "p-1": "Distill Code",
  "p-2": "Tools",
  "project-id-7": "Tools",
};
const nameOf = (projectId: string | null) =>
  projectId === null
    ? "Everywhere"
    : (PROJECT_NAMES[projectId] ?? "A project that no longer exists");

describe("composeReviewMessage", () => {
  it("asks for a list first and forbids applying anything unconfirmed", () => {
    const message = composeReviewMessage([], 0, nameOf);

    expect(message).toContain("Duplicates and near-duplicates");
    expect(message).toContain("Contradictions");
    expect(message).toContain("Stale");
    expect(message).toContain("Apply nothing yet");
    expect(message).toContain("distill-memory");
    expect(message).toContain("at most 5 per reply");
    expect(message).toContain("Do not restate a secret");
    expect(message).toContain("Nothing is remembered yet");
  });

  it("groups the record the way the panel does, newest line first", () => {
    const message = composeReviewMessage(
      [
        entry({ id: "g1", text: "Ivan reviews Rust himself", createdAt: DAY }),
        entry({
          id: "p1",
          text: "The release branch is release/2026.9",
          scope: "project",
          projectId: "p-1",
          createdAt: DAY,
        }),
        entry({ id: "g2", text: "Ivan prefers short replies", createdAt: 0 }),
        entry({
          id: "p2",
          text: "Migrations run from the tools folder",
          scope: "project",
          projectId: "p-2",
          createdAt: 0,
        }),
      ],
      0,
      nameOf,
    );

    expect(message).toContain("## Everywhere");
    expect(message).toContain("## Distill Code");
    expect(message).toContain("## Tools");
    // Everywhere before the projects, and inside it the newer line first.
    expect(message.indexOf("## Everywhere")).toBeLessThan(
      message.indexOf("## Distill Code"),
    );
    expect(message.indexOf("Ivan reviews Rust himself")).toBeLessThan(
      message.indexOf("Ivan prefers short replies"),
    );
  });

  it("dates every line and says when an agent confirmed one", () => {
    const message = composeReviewMessage(
      [
        entry({ id: "a", text: "Plain fact", createdAt: DAY }),
        entry({
          id: "b",
          text: "Restated fact",
          createdAt: DAY,
          reinforcedAt: 3 * DAY,
        }),
      ],
      0,
      nameOf,
    );

    expect(message).toContain('- "Plain fact" (kept 1970-01-02)');
    expect(message).toContain(
      '- "Restated fact" (kept 1970-01-02, confirmed 1970-01-04)',
    );
  });

  it("counts the archive instead of dumping it", () => {
    const message = composeReviewMessage([entry({ id: "a" })], 7, nameOf);

    expect(message).toContain("7 memories are archived and not listed here");
  });

  it("says nothing about an empty archive, and never a negative count", () => {
    expect(composeReviewMessage([entry({ id: "a" })], 0, nameOf)).not.toContain(
      "archived",
    );
    expect(
      composeReviewMessage([entry({ id: "a" })], -3, nameOf),
    ).not.toContain("archived");
  });

  it("prints the statements and their dates and nothing else about them", () => {
    const message = composeReviewMessage(
      [
        entry({
          id: "entry-id-42",
          text: "Ivan reviews Rust himself",
          createdBySessionId: "session-id-99",
        }),
        entry({
          id: "entry-id-43",
          text: "Migrations run from the tools folder",
          scope: "project",
          projectId: "project-id-7",
          createdBySessionId: "session-id-99",
        }),
      ],
      0,
      nameOf,
    );

    // Ids and provenance are the app's bookkeeping, not the operator's record.
    expect(message).not.toContain("entry-id-42");
    expect(message).not.toContain("entry-id-43");
    expect(message).not.toContain("session-id-99");
    // The project reaches the message as the name the panel shows, never as
    // the id the store keys it by.
    expect(message).not.toContain("project-id-7");
    expect(message).toContain("## Tools");
  });

  it("cuts an oversized record and says how much it cut", () => {
    const long = "x".repeat(280);
    const entries = Array.from({ length: 300 }, (_, index) =>
      entry({ id: `e-${index}`, text: long, createdAt: index }),
    );

    const message = composeReviewMessage(entries, 0, nameOf);

    expect(message.length).toBeLessThan(50_000);
    const dumped = message.split("\n").filter((line) => line.startsWith('- "'));
    expect(dumped.length).toBeLessThan(entries.length);
    expect(dumped.length * long.length).toBeLessThanOrEqual(
      MAX_REVIEW_DUMP_CHARS,
    );
    expect(message).toContain(
      `${entries.length - dumped.length} more live memories are kept but left out`,
    );
  });
});

describe("startMemoryReviewChat", () => {
  it("creates a projectless chat carrying the message, then opens it", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ session_id: "review-1" })
      .mockResolvedValueOnce({ ok: true });

    await expect(startMemoryReviewChat("the dump", dispatch)).resolves.toBe(
      "review-1",
    );

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "sessions",
      { action: "create", prompt: "the dump" },
      {},
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "sessions",
      { action: "open", session_id: "review-1" },
      {},
    );
  });

  it("does not try to open a chat that was never created", async () => {
    const dispatch = vi.fn().mockResolvedValueOnce({});

    await expect(startMemoryReviewChat("the dump", dispatch)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
