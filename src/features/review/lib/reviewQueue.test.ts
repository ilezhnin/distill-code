import { describe, expect, it } from "vitest";

import type { SessionNode, StructuredReport } from "@/features/conductor/types";

import { buildReviewQueue, withConductorNames } from "./reviewQueue";

const SEEN = 1_000;

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "p",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${overrides.sessionId}`,
    harnessId: "goose",
    displayName: "Worker",
    status: "completed",
    createdAt: 1,
    finishedAt: SEEN + 100,
    ...overrides,
  };
}

function report(
  overrides: Partial<StructuredReport> & { runId: string },
): StructuredReport {
  return {
    status: "completed",
    summary: "Did the thing",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...overrides,
  };
}

function reportsFrom(list: StructuredReport[]) {
  const byRunId = new Map(list.map((entry) => [entry.runId, entry]));
  return (runId: string) => byRunId.get(runId);
}

describe("buildReviewQueue", () => {
  it("groups a conductor's finished agents into one row", () => {
    const items = buildReviewQueue({
      nodes: [
        node({ sessionId: "w1" }),
        node({ sessionId: "w2", finishedAt: SEEN + 200 }),
      ],
      reportOf: reportsFrom([
        report({ runId: "run-w1", summary: "First" }),
        report({ runId: "run-w2", summary: "Second" }),
      ]),
      lastSeenAt: SEEN,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sessionId: "conductor-1",
      completed: 2,
      failed: 0,
      latestAt: SEEN + 200,
      // The newest finish owns the row's words.
      summary: "Second",
    });
  });

  it("leads with the agent that is waiting on a person", () => {
    const items = buildReviewQueue({
      nodes: [
        node({ sessionId: "ok", rootConductorId: "c-quiet" }),
        node({ sessionId: "stuck", rootConductorId: "c-stuck" }),
      ],
      reportOf: reportsFrom([
        report({ runId: "run-ok" }),
        report({ runId: "run-stuck", needsOperator: true }),
      ]),
      lastSeenAt: SEEN,
    });

    expect(items.map((item) => item.sessionId)).toEqual(["c-stuck", "c-quiet"]);
    expect(items[0].outcome).toBe("needsOperator");
  });

  it("puts a failure above a plain finish and below a person being needed", () => {
    const items = buildReviewQueue({
      nodes: [
        node({ sessionId: "a", rootConductorId: "c-done" }),
        node({ sessionId: "b", rootConductorId: "c-failed", status: "failed" }),
        node({ sessionId: "c", rootConductorId: "c-stuck" }),
      ],
      reportOf: reportsFrom([report({ runId: "run-c", needsOperator: true })]),
      lastSeenAt: SEEN,
    });

    expect(items.map((item) => item.outcome)).toEqual([
      "needsOperator",
      "failed",
      "completed",
    ]);
  });

  it("counts a cancelled agent as a failure, not a finish", () => {
    const [item] = buildReviewQueue({
      nodes: [node({ sessionId: "w", status: "cancelled" })],
      reportOf: () => undefined,
      lastSeenAt: SEEN,
    });

    expect(item).toMatchObject({ failed: 1, completed: 0, outcome: "failed" });
  });

  it("says nothing about work the operator has already read", () => {
    expect(
      buildReviewQueue({
        nodes: [node({ sessionId: "w", finishedAt: SEEN - 1 })],
        reportOf: () => undefined,
        lastSeenAt: SEEN,
      }),
    ).toEqual([]);
  });

  it("treats an unstamped node as already seen", () => {
    // Nodes that predate `finishedAt` must not announce a month of old runs
    // as if they had just landed.
    expect(
      buildReviewQueue({
        nodes: [node({ sessionId: "w", finishedAt: undefined })],
        reportOf: () => undefined,
        lastSeenAt: 0,
      }),
    ).toEqual([]);
  });

  it("ignores agents that are still working", () => {
    expect(
      buildReviewQueue({
        nodes: [node({ sessionId: "w", status: "running" })],
        reportOf: () => undefined,
        lastSeenAt: SEEN,
      }),
    ).toEqual([]);
  });

  it("ignores the conductors themselves", () => {
    // A conductor is the operator's own chat, not a piece of finished work.
    expect(
      buildReviewQueue({
        nodes: [node({ sessionId: "c", role: "conductor" })],
        reportOf: () => undefined,
        lastSeenAt: SEEN,
      }),
    ).toEqual([]);
  });

  it("files a nested worker under its root conductor, not its parent", () => {
    const [item] = buildReviewQueue({
      nodes: [
        node({
          sessionId: "deep",
          parentSessionId: "orchestrator-1",
          rootConductorId: "conductor-9",
        }),
      ],
      reportOf: () => undefined,
      lastSeenAt: SEEN,
    });

    expect(item.sessionId).toBe("conductor-9");
  });

  it("falls back to the parent when no root is recorded", () => {
    const [item] = buildReviewQueue({
      nodes: [
        node({
          sessionId: "orphan",
          parentSessionId: "parent-3",
          rootConductorId: null,
        }),
      ],
      reportOf: () => undefined,
      lastSeenAt: SEEN,
    });

    expect(item.sessionId).toBe("parent-3");
  });
});

describe("withConductorNames", () => {
  const items = buildReviewQueue({
    nodes: [node({ sessionId: "w" })],
    reportOf: () => undefined,
    lastSeenAt: SEEN,
  });

  it("names a row after its conductor", () => {
    expect(
      withConductorNames(items, () => "Nightly build", "Unknown")[0]
        .displayName,
    ).toBe("Nightly build");
  });

  it("keeps a row whose conductor is gone", () => {
    // The work still happened; a row the operator cannot open still says so.
    const named = withConductorNames(items, () => undefined, "Unknown");
    expect(named).toHaveLength(1);
    expect(named[0].displayName).toBe("Unknown");
  });
});
