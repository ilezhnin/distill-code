import { describe, expect, it } from "vitest";

import {
  brigadeWaitIndicator,
  isWorkingStatus,
  summarizeBrigadeActivity,
  workingChildCountForSession,
} from "./brigadeActivity";
import type { SessionNode } from "./types";

function node(
  sessionId: string,
  status: SessionNode["status"],
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status,
    ...overrides,
  };
}

describe("isWorkingStatus", () => {
  it("treats starting/running/waiting as working and the rest as terminal", () => {
    expect(isWorkingStatus("starting")).toBe(true);
    expect(isWorkingStatus("running")).toBe(true);
    expect(isWorkingStatus("waiting")).toBe(true);
    expect(isWorkingStatus("completed")).toBe(false);
    expect(isWorkingStatus("failed")).toBe(false);
    expect(isWorkingStatus("cancelled")).toBe(false);
    expect(isWorkingStatus("stopped")).toBe(false);
  });
});

describe("summarizeBrigadeActivity", () => {
  it("tallies working and completed children", () => {
    expect(
      summarizeBrigadeActivity([
        node("a", "running"),
        node("b", "waiting"),
        node("c", "completed"),
        node("d", "failed"),
      ]),
    ).toEqual({ working: 2, done: 1 });
  });

  it("returns zeroes for an empty brigade", () => {
    expect(summarizeBrigadeActivity([])).toEqual({ working: 0, done: 0 });
  });
});

describe("brigadeWaitIndicator", () => {
  it("shows the working count when the session is idle and children work", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "idle",
        children: [
          node("a", "running"),
          node("b", "starting"),
          node("c", "waiting"),
          node("d", "completed"),
        ],
      }),
    ).toMatchObject({ visible: true, workingCount: 3 });
  });

  it("counts children of any managedBy and either executor role", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "idle",
        children: [
          node("ui", "running", { managedBy: "ui", role: "orchestrator" }),
          node("wave", "running", { managedBy: "wave" }),
          node("cli", "starting", { managedBy: "agent-cli" }),
        ],
      }),
    ).toMatchObject({ visible: true, workingCount: 3 });
  });

  it("hides while the session itself is running", () => {
    for (const chatState of [
      "thinking",
      "streaming",
      "waiting",
      "compacting",
    ] as const) {
      expect(
        brigadeWaitIndicator({
          chatState,
          children: [node("a", "running")],
        }),
      ).toMatchObject({ visible: false, workingCount: 1 });
    }
  });

  it("hides when every child reached a terminal status", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "idle",
        children: [
          node("a", "completed"),
          node("b", "failed"),
          node("c", "cancelled"),
          node("d", "stopped"),
        ],
      }),
    ).toMatchObject({ visible: false, workingCount: 0 });
  });

  it("hides when the session has no children", () => {
    expect(
      brigadeWaitIndicator({ chatState: "idle", children: [] }),
    ).toMatchObject({
      visible: false,
      workingCount: 0,
    });
  });

  it("still shows after the session's own turn errored out", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "error",
        children: [node("a", "running")],
      }),
    ).toMatchObject({ visible: true, workingCount: 1 });
  });
});

describe("workingChildCountForSession", () => {
  const conductor = node("conductor-1", "waiting", {
    role: "conductor",
    parentSessionId: null,
    rootConductorId: null,
  });

  function graph(...nodes: SessionNode[]): Record<string, SessionNode> {
    return Object.fromEntries(nodes.map((item) => [item.sessionId, item]));
  }

  it("counts only the working children of the session", () => {
    expect(
      workingChildCountForSession(
        graph(
          conductor,
          node("w1", "running"),
          node("w2", "starting"),
          node("w3", "waiting"),
          node("w4", "completed"),
        ),
        "conductor-1",
      ),
    ).toBe(3);
  });

  it("returns 0 once every child reached a terminal state", () => {
    expect(
      workingChildCountForSession(
        graph(
          conductor,
          node("w1", "completed"),
          node("w2", "failed"),
          node("w3", "cancelled"),
          node("w4", "stopped"),
        ),
        "conductor-1",
      ),
    ).toBe(0);
  });

  it("ignores the session's own node even while it is running", () => {
    const runningConductor = node("conductor-1", "running", {
      role: "conductor",
      parentSessionId: null,
      rootConductorId: null,
    });
    expect(
      workingChildCountForSession(graph(runningConductor), "conductor-1"),
    ).toBe(0);
  });

  it("does not count children belonging to a different parent", () => {
    expect(
      workingChildCountForSession(
        graph(
          conductor,
          node("mine", "running"),
          node("theirs", "running", {
            parentSessionId: "conductor-2",
            rootConductorId: "conductor-2",
          }),
        ),
        "conductor-1",
      ),
    ).toBe(1);
  });

  it("returns 0 for an empty graph and for sessions with no node", () => {
    expect(workingChildCountForSession({}, "conductor-1")).toBe(0);
    expect(
      workingChildCountForSession(graph(node("w1", "running")), "conductor-1"),
    ).toBe(0);
  });

  it("counts the children of a session whatever role it carries", () => {
    // Ownership is the parent link, not the parent's title. A plain chat that
    // started an agent has an agent running for the operator, and a rule that
    // returned 0 here made exactly those agents the invisible ones.
    const plain = node("plain-1", "waiting", {
      role: "plain-chat",
      parentSessionId: null,
      rootConductorId: null,
    });
    expect(
      workingChildCountForSession(
        graph(
          plain,
          node("w1", "running", {
            parentSessionId: "plain-1",
            rootConductorId: "plain-1",
          }),
        ),
        "plain-1",
      ),
    ).toBe(1);
  });

  it("counts an orchestrator's direct workers", () => {
    const orchestrator = node("orch-1", "waiting", {
      role: "orchestrator",
      parentSessionId: "conductor-1",
    });
    expect(
      workingChildCountForSession(
        graph(
          orchestrator,
          node("w1", "running", { parentSessionId: "orch-1" }),
          node("w2", "running", {
            parentSessionId: "conductor-1",
            rootConductorId: "conductor-1",
          }),
        ),
        "orch-1",
      ),
    ).toBe(1);
  });

  it("reaches children still pointed at a pre-promotion client session id", () => {
    const promoted = node("real-1", "waiting", {
      role: "conductor",
      parentSessionId: null,
      rootConductorId: null,
    });
    const nodes = graph(
      promoted,
      node("w1", "running", {
        parentSessionId: "client-1",
        rootConductorId: "client-1",
      }),
    );
    expect(workingChildCountForSession(nodes, "real-1")).toBe(0);
    expect(workingChildCountForSession(nodes, "real-1", ["client-1"])).toBe(1);
  });

  it("resolves the root through an alias when the node is keyed by it", () => {
    const nodes = graph(
      node("client-1", "waiting", {
        role: "conductor",
        parentSessionId: null,
        rootConductorId: null,
      }),
      node("w1", "running", {
        parentSessionId: "client-1",
        rootConductorId: "client-1",
      }),
    );
    expect(
      workingChildCountForSession(nodes, "real-1", [undefined, "client-1"]),
    ).toBe(1);
  });

  it("hands back the executors the count is about (L4)", () => {
    // The line is an entrance, not just a number: the indicator needs the
    // nodes themselves to offer each one's chat, and only the working ones —
    // a finished executor is reachable from its chip, and repeating it here
    // would make the line lie about who is still running.
    const result = brigadeWaitIndicator({
      chatState: "idle",
      children: [
        node("a", "running"),
        node("b", "completed"),
        node("c", "waiting"),
      ],
    });
    expect(result.working.map((entry) => entry.sessionId)).toEqual(["a", "c"]);
    expect(result.workingCount).toBe(2);
  });
});
