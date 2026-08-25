import { describe, expect, it } from "vitest";

import type { WaveStep } from "./distillWave";
import type { SessionNode } from "./types";
import { pendingStepName, waveFooterRow } from "./waveFooterChips";

function step(overrides: Partial<WaveStep> = {}): WaveStep {
  return {
    role: "brigade",
    subtask: "Do the thing",
    access: [],
    ...overrides,
  };
}

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "p",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "c",
    rootConductorId: "c",
    runId: `run-${overrides.sessionId}`,
    harnessId: "goose",
    displayName: "Worker",
    status: "running",
    ...overrides,
  };
}

describe("waveFooterRow", () => {
  it("gives every planned step a slot, spawned or not", () => {
    const { slots } = waveFooterRow(
      [step(), step({ role: "critic" }), step({ role: "scribe" })],
      [node({ sessionId: "w0", stepIndex: 0 })],
    );

    expect(slots).toHaveLength(3);
    expect(slots[0].node?.sessionId).toBe("w0");
    expect(slots[1].node).toBeUndefined();
    expect(slots[2].node).toBeUndefined();
  });

  it("keeps slots in plan order however the graph registered them", () => {
    // The graph hands children back in spawn-completion order.
    const { slots } = waveFooterRow(
      [step(), step()],
      [
        node({ sessionId: "second", stepIndex: 1 }),
        node({ sessionId: "first", stepIndex: 0 }),
      ],
    );

    expect(slots.map((slot) => slot.node?.sessionId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("appends a child the plan has no place for rather than losing it", () => {
    const { slots, unplanned } = waveFooterRow(
      [step()],
      [
        node({ sessionId: "planned", stepIndex: 0 }),
        node({ sessionId: "beyond", stepIndex: 4 }),
        node({ sessionId: "legacy" }),
      ],
    );

    expect(slots).toHaveLength(1);
    expect(unplanned.map((entry) => entry.sessionId)).toEqual([
      "beyond",
      "legacy",
    ]);
  });

  it("does not swallow a second child claiming the same step", () => {
    const { slots, unplanned } = waveFooterRow(
      [step()],
      [
        node({ sessionId: "first", stepIndex: 0 }),
        node({ sessionId: "double", stepIndex: 0 }),
      ],
    );

    expect(slots[0].node?.sessionId).toBe("first");
    expect(unplanned.map((entry) => entry.sessionId)).toEqual(["double"]);
  });

  it("is the nodes as they are when there is no plan", () => {
    // The legacy orchestrator row: nothing promised, nothing to hold a place.
    const { slots, unplanned } = waveFooterRow([], [node({ sessionId: "a" })]);
    expect(slots).toEqual([]);
    expect(unplanned.map((entry) => entry.sessionId)).toEqual(["a"]);
  });

  it("holds places for a plan nothing has started", () => {
    const { slots } = waveFooterRow([step(), step()], []);
    expect(slots.every((slot) => slot.node === undefined)).toBe(true);
    expect(slots).toHaveLength(2);
  });
});

describe("pendingStepName", () => {
  it("uses the role's own name, the one the plan above the row used", () => {
    expect(pendingStepName(step({ role: "producer" }))).toBe("Producer");
  });

  it("keeps an unknown role's id rather than calling it something else", () => {
    // A plan that named a role we do not have is exactly the case where the
    // operator needs to read what it named.
    expect(pendingStepName(step({ role: "chandler" }))).toBe("chandler");
  });
});
