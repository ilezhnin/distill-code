import { describe, expect, it } from "vitest";

import {
  hasLiveRuntime,
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
  it("stops a running child that has no runtime and no queued send", () => {
    expect(reconcile([node("worker-1", "worker", "running")])).toEqual([
      "worker-1",
    ]);
  });

  it("stops starting and waiting children too", () => {
    expect(
      reconcile([
        node("worker-1", "worker", "starting"),
        node("orchestrator-1", "orchestrator", "waiting"),
      ]),
    ).toEqual(["worker-1", "orchestrator-1"]);
  });

  it("leaves a child with a live runtime alone", () => {
    expect(
      reconcile([node("worker-1", "worker", "running")], {
        sessionStateById: { "worker-1": { chatState: "streaming" } },
      }),
    ).toEqual([]);
  });

  it("leaves a child whose runtime is thinking or compacting alone", () => {
    expect(
      reconcile(
        [
          node("worker-1", "worker", "running"),
          node("worker-2", "worker", "running"),
        ],
        {
          sessionStateById: {
            "worker-1": { chatState: "thinking" },
            "worker-2": { chatState: "compacting" },
          },
        },
      ),
    ).toEqual([]);
  });

  it("stops a child whose only runtime entry is an idle unread placeholder", () => {
    // The chat store seeds `sessionStateById` with idle entries for sessions
    // that merely carry an unread flag — that is not a running session.
    expect(
      reconcile([node("worker-1", "worker", "running")], {
        sessionStateById: { "worker-1": { chatState: "idle" } },
      }),
    ).toEqual(["worker-1"]);
  });

  it("leaves a child with an errored or cancelling runtime to statusFromRuntime", () => {
    expect(
      reconcile(
        [
          node("worker-1", "worker", "running"),
          node("worker-2", "worker", "running"),
        ],
        {
          sessionStateById: {
            "worker-1": { chatState: "error" },
            "worker-2": {
              chatState: "idle",
              isRunCancellationPending: true,
            },
          },
        },
      ),
    ).toEqual([]);
  });

  it("leaves a child with a queued first send alone", () => {
    expect(
      reconcile([node("worker-1", "worker", "starting")], {
        queued: ["worker-1"],
      }),
    ).toEqual([]);
  });

  it("never touches conductor or plain-chat nodes", () => {
    expect(
      reconcile([
        node("conductor-1", "conductor", "running"),
        node("chat-1", "plain-chat", "running"),
      ]),
    ).toEqual([]);
  });

  it("never touches terminal statuses", () => {
    expect(
      reconcile([
        node("worker-1", "worker", "completed"),
        node("worker-2", "worker", "failed"),
        node("worker-3", "worker", "cancelled"),
        node("worker-4", "worker", "stopped"),
      ]),
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

  it("is a pure decision: it does not mutate the nodes it inspects", () => {
    const nodes = [node("worker-1", "worker", "running")];
    const snapshot = structuredClone(nodes);
    reconcile(nodes);
    expect(nodes).toEqual(snapshot);
  });

  it("also accepts wave-managed nodes", () => {
    expect(
      reconcile([
        node("worker-1", "worker", "running", {
          managedBy: "wave",
          waveId: "wave-1",
          stepIndex: 0,
        }),
      ]),
    ).toEqual(["worker-1"]);
  });
});

describe("hasLiveRuntime", () => {
  it("is false without a runtime entry", () => {
    expect(hasLiveRuntime(undefined)).toBe(false);
  });

  it("is false for an idle runtime", () => {
    expect(hasLiveRuntime({ chatState: "idle" })).toBe(false);
  });

  it("is true for every busy chat state", () => {
    for (const chatState of [
      "thinking",
      "streaming",
      "waiting",
      "compacting",
      "error",
    ] as const) {
      expect(hasLiveRuntime({ chatState })).toBe(true);
    }
  });
});
