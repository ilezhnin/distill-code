import { describe, expect, it } from "vitest";

import {
  buildAgentForest,
  countAgents,
  countWorkingAgents,
  findAgentSubtree,
  flattenAgentForest,
} from "./agentTree";
import type { SessionNode } from "./types";

function node(
  sessionId: string,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "p1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: null,
    rootConductorId: null,
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status: "running",
    ...overrides,
  };
}

function graph(...nodes: SessionNode[]): Record<string, SessionNode> {
  const byId: Record<string, SessionNode> = {};
  for (const n of nodes) byId[n.sessionId] = n;
  return byId;
}

describe("buildAgentForest", () => {
  it("nests children under the parent that started them", () => {
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor" }),
        node("orch", { role: "orchestrator", parentSessionId: "c" }),
        node("w", { parentSessionId: "orch" }),
      ),
    );
    expect(forest).toHaveLength(1);
    expect(forest[0].node.sessionId).toBe("c");
    expect(forest[0].children[0].node.sessionId).toBe("orch");
    expect(forest[0].children[0].children[0].node.sessionId).toBe("w");
    expect(flattenAgentForest(forest).map((row) => row.depth)).toEqual([
      0, 1, 2,
    ]);
  });

  it("adopts a node whose parent is gone onto its root conductor", () => {
    // Graph bounds drop old nodes. A worker left pointing at a dropped
    // orchestrator must not float to the top as a second brigade — the
    // conductor it belongs to is still the truthful place for it.
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor" }),
        node("w", { parentSessionId: "gone", rootConductorId: "c" }),
      ),
    );
    expect(forest).toHaveLength(1);
    expect(forest[0].children.map((child) => child.node.sessionId)).toEqual([
      "w",
    ]);
  });

  it("orders siblings by wave step, then by age", () => {
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor" }),
        node("s2", { parentSessionId: "c", stepIndex: 1, createdAt: 1 }),
        node("s1", { parentSessionId: "c", stepIndex: 0, createdAt: 9 }),
        node("late", { parentSessionId: "c", createdAt: 5 }),
        node("early", { parentSessionId: "c", createdAt: 2 }),
      ),
    );
    expect(forest[0].children.map((child) => child.node.sessionId)).toEqual([
      "s1",
      "s2",
      "early",
      "late",
    ]);
  });

  it("keeps a finished parent whose child is still running", () => {
    // Dropping it would orphan the worker and lose the one fact that explains
    // why the worker exists at all.
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor", status: "completed" }),
        node("orch", {
          role: "orchestrator",
          parentSessionId: "c",
          status: "completed",
        }),
        node("w", { parentSessionId: "orch", status: "running" }),
      ),
      { include: "live" },
    );
    expect(flattenAgentForest(forest).map((row) => row.node.sessionId)).toEqual(
      ["c", "orch", "w"],
    );
    expect(forest[0].workingInSubtree).toBe(1);
  });

  it("drops a subtree with nothing working in it", () => {
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor", status: "completed" }),
        node("w", { parentSessionId: "c", status: "completed" }),
      ),
      { include: "live" },
    );
    expect(forest).toHaveLength(0);
  });

  it("keeps projects apart", () => {
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor" }),
        node("other", { projectId: "p2" }),
      ),
      { projectId: "p1" },
    );
    expect(forest.map((tree) => tree.node.sessionId)).toEqual(["c"]);
  });

  it("builds from named roots only, and can hand back their children", () => {
    const nodes = graph(
      node("c", { role: "conductor" }),
      node("w", { parentSessionId: "c" }),
      node("stranger"),
    );
    expect(
      buildAgentForest(nodes, { rootSessionIds: ["c"] }).map(
        (tree) => tree.node.sessionId,
      ),
    ).toEqual(["c"]);
    const promoted = buildAgentForest(nodes, {
      rootSessionIds: ["c"],
      excludeRoots: true,
    });
    expect(promoted.map((tree) => tree.node.sessionId)).toEqual(["w"]);
    expect(promoted[0].depth).toBe(0);
  });

  it("survives a parent cycle rather than recursing forever", () => {
    // These links are persisted data. A hand-edited or badly merged
    // `localStorage` must not be able to hang the renderer.
    const forest = buildAgentForest(
      graph(
        node("a", { parentSessionId: "b" }),
        node("b", { parentSessionId: "a" }),
      ),
    );
    expect(countAgents(forest)).toBeLessThanOrEqual(2);
  });

  it("counts agents and working agents at every depth", () => {
    const forest = buildAgentForest(
      graph(
        node("c", { role: "conductor", status: "waiting" }),
        node("w1", { parentSessionId: "c", status: "running" }),
        node("w2", { parentSessionId: "w1", status: "completed" }),
      ),
    );
    expect(countAgents(forest)).toBe(3);
    expect(countWorkingAgents(forest)).toBe(2);
    expect(findAgentSubtree(forest, "w2")?.node.sessionId).toBe("w2");
    expect(findAgentSubtree(forest, "nope")).toBeNull();
  });
});
