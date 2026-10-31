import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "./memoryEntry";
import {
  memoryFenceOutcome,
  type MemoryFenceOutcomeInput,
} from "./memoryFenceOutcome";

const entry = (text: string, projectId: string | null): MemoryEntry => ({
  id: text,
  text,
  scope: projectId ? "project" : "global",
  projectId,
  createdAt: 1,
});

const input = (
  overrides: Partial<MemoryFenceOutcomeInput>,
): MemoryFenceOutcomeInput => ({
  request: {
    remember: [{ text: "The cache is opt-in", scope: "project" }],
    forget: [],
  },
  handled: true,
  writeEnabled: true,
  denial: null,
  projectId: "fallout",
  entries: [],
  archived: [],
  refusalOf: () => null,
  ...overrides,
});

/**
 * The record in the transcript says what the memory holds, not what the agent
 * asked for: a request is not a saved memory until the store has it.
 */
describe("memoryFenceOutcome", () => {
  it("reports a statement the store holds as saved", () => {
    const outcome = memoryFenceOutcome(
      input({ entries: [entry("The cache is opt-in", "fallout")] }),
    );
    expect(outcome.status).toBe("saved");
    expect(outcome.statements[0]?.state).toBe("kept");
  });

  it("waits until the store has applied the block", () => {
    expect(memoryFenceOutcome(input({ handled: false })).status).toBe(
      "pending",
    );
    expect(
      memoryFenceOutcome(input({ handled: false, writeEnabled: false })).status,
    ).toBe("paused");
  });

  it("says a refused statement was not saved, and why", () => {
    const outcome = memoryFenceOutcome(
      input({ refusalOf: () => ({ reason: "no-project" }) }),
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.statements[0]?.refusal).toEqual({ reason: "no-project" });
  });

  it("never calls a session's request saved when the session may not write", () => {
    const outcome = memoryFenceOutcome(
      input({
        denial: "wave-child",
        entries: [entry("The cache is opt-in", "fallout")],
      }),
    );
    expect(outcome.status).toBe("denied");
    expect(outcome.statements[0]?.state).toBe("refused");
  });

  it("does not count another project's line as this one's", () => {
    const outcome = memoryFenceOutcome(
      input({ entries: [entry("The cache is opt-in", "other")] }),
    );
    expect(outcome.statements[0]?.state).toBe("removed");
  });
});
