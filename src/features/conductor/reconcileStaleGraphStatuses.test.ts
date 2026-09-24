import { describe, expect, it } from "vitest";

import {
  reconcileStaleGraphStatuses,
  type StaleStatusRuntime,
} from "./reconcileStaleGraphStatuses";
import type { RunStatus, SessionNode, SessionRole } from "./types";

function node(
  sessionId: string,
  role: SessionRole,
  status: RunStatus,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role,
    managedBy: "ui",
    parentSessionId: role === "conductor" ? null : "conductor-1",
    rootConductorId: "conductor-1",
    runId: role === "conductor" ? null : `run-${sessionId}`,
    harnessId: "goose",
    displayName: sessionId,
    status,
    createdAt: 1,
    ...overrides,
  };
}

function reconcile(
  nodes: SessionNode[],
  options: {
    sessionStateById?: Record<string, StaleStatusRuntime | undefined>;
    queued?: string[];
  } = {},
): string[] {
  const queued = new Set(options.queued ?? []);
  return reconcileStaleGraphStatuses(nodes, {
    sessionStateById: options.sessionStateById ?? {},
    hasQueuedFirstSend: (sessionId) => queued.has(sessionId),
  });
}

describe("reconcileStaleGraphStatuses", () => {
  it("stops a child whose only runtime entry is an idle unread placeholder", () => {
    // The chat store seeds `sessionStateById` with idle entries for sessions
    // that merely carry an unread flag — that is not a running session.
    expect(
      reconcile([node("worker-1", "worker", "running")], {
        sessionStateById: { "worker-1": { chatState: "idle" } },
      }),
    ).toEqual(["worker-1"]);
  });

  it("leaves a child with a queued first send alone", () => {
    expect(
      reconcile([node("worker-1", "worker", "starting")], {
        queued: ["worker-1"],
      }),
    ).toEqual([]);
  });

  it("reports only the stale nodes of a mixed graph", () => {
    expect(
      reconcile(
        [
          node("conductor-1", "conductor", "running"),
          node("orchestrator-1", "orchestrator", "running"),
          node("worker-live", "worker", "running"),
          node("worker-queued", "worker", "starting"),
          node("worker-stale", "worker", "waiting"),
          node("worker-done", "worker", "completed"),
        ],
        {
          sessionStateById: { "worker-live": { chatState: "waiting" } },
          queued: ["worker-queued"],
        },
      ),
    ).toEqual(["orchestrator-1", "worker-stale"]);
  });
});
