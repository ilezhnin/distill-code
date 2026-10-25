import { describe, expect, it } from "vitest";

import { indexAgentChildren } from "./agentTree";
import type { SessionNode } from "./types";

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: null,
    runId: null,
    harnessId: "harness",
    displayName: overrides.sessionId,
    status: "completed",
    createdAt: 1,
    ...overrides,
  };
}

function byId(nodes: SessionNode[]): Record<string, SessionNode> {
  return Object.fromEntries(nodes.map((entry) => [entry.sessionId, entry]));
}

const ids = (
  forest: ReturnType<ReturnType<typeof indexAgentChildren>["forestUnder"]>,
) => forest.map((tree) => tree.node.sessionId);

describe("indexAgentChildren", () => {
  const conductor = node({
    sessionId: "conductor",
    role: "conductor",
    rootConductorId: "conductor",
    status: "stopped",
  });
  const orchestrator = node({
    sessionId: "orchestrator",
    role: "orchestrator",
    parentSessionId: "conductor",
    rootConductorId: "conductor",
    status: "waiting",
    createdAt: 2,
  });
  const worker = node({
    sessionId: "worker",
    parentSessionId: "orchestrator",
    rootConductorId: "conductor",
    status: "running",
    createdAt: 3,
  });
  // Its orchestrator was evicted by the graph bound: only the conductor is left.
  const orphan = node({
    sessionId: "orphan",
    parentSessionId: "evicted-orchestrator",
    rootConductorId: "conductor",
    createdAt: 4,
  });
  // Started by an ordinary chat, which registers no node of its own.
  const plainChild = node({
    sessionId: "plain-child",
    parentSessionId: "plain-chat",
    rootConductorId: "plain-chat",
    createdAt: 5,
  });
  const aliasChild = node({
    sessionId: "alias-child",
    parentSessionId: "plain-chat-draft",
    rootConductorId: "plain-chat-draft",
    createdAt: 6,
  });
  const index = indexAgentChildren(
    byId([conductor, orchestrator, worker, orphan, plainChild, aliasChild]),
  );

  it("hangs every linked node under the chat that started it, at every depth", () => {
    const forest = index.forestUnder(["conductor"]);
    expect(ids(forest)).toEqual(["orchestrator", "orphan"]);
    expect(forest[0]?.depth).toBe(0);
    expect(ids(forest[0]?.children ?? [])).toEqual(["worker"]);
    expect(forest[0]?.children[0]?.depth).toBe(1);
    expect(forest[0]?.workingInSubtree).toBe(2);
    expect(forest[1]?.workingInSubtree).toBe(0);
  });

  it("needs no node for the chat at the top, and reads a session's aliases", () => {
    expect(ids(index.forestUnder(["plain-chat"]))).toEqual(["plain-child"]);
    expect(
      ids(
        index.forestUnder([
          "plain-chat",
          null,
          undefined,
          "",
          "plain-chat-draft",
        ]),
      ),
    ).toEqual(["plain-child", "alias-child"]);
    expect(index.forestUnder(["nobody"])).toEqual([]);
    expect(index.forestUnder([])).toEqual([]);
  });

  it("marks exactly the linked nodes as nested", () => {
    expect([...index.nestedSessionIds].sort()).toEqual(
      ["alias-child", "orchestrator", "orphan", "plain-child", "worker"].sort(),
    );
  });

  it("walks the ancestor chain nearest first, through evicted parents", () => {
    expect(index.ancestorsOf("worker")).toEqual(["orchestrator", "conductor"]);
    expect(index.ancestorsOf("orphan")).toEqual(["conductor"]);
    expect(index.ancestorsOf("plain-child")).toEqual(["plain-chat"]);
    expect(index.ancestorsOf("conductor")).toEqual([]);
    expect(index.ancestorsOf("unknown")).toEqual([]);
  });

  it("ends a persisted cycle at its first repeat", () => {
    const cyclic = indexAgentChildren(
      byId([
        node({ sessionId: "a", parentSessionId: "b" }),
        node({ sessionId: "b", parentSessionId: "a" }),
      ]),
    );
    const forest = cyclic.forestUnder(["a"]);
    expect(ids(forest)).toEqual(["b"]);
    expect(forest[0]?.children).toEqual([]);
    expect(cyclic.ancestorsOf("a")).toEqual(["b"]);
  });

  it("ignores a node's alias key and a node that names itself as parent", () => {
    const self = node({ sessionId: "self", parentSessionId: "self" });
    const aliased = indexAgentChildren({
      ...byId([conductor, worker, self]),
      "worker-alias": worker,
    });
    expect(ids(aliased.forestUnder(["conductor"]))).toEqual(["worker"]);
    expect(aliased.nestedSessionIds.has("self")).toBe(false);
    expect(aliased.nestedSessionIds.has("worker")).toBe(true);
  });
});
