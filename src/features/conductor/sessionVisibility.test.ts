import { describe, expect, it } from "vitest";

import { footerAgentNodes } from "./sessionVisibility";
import type { SessionNode } from "./types";

function node(overrides: Partial<SessionNode>): SessionNode {
  return {
    sessionId: "node",
    projectId: "project",
    role: "worker",
    managedBy: "agent-cli",
    parentSessionId: null,
    rootConductorId: null,
    runId: "run",
    harnessId: "claude-acp",
    displayName: "Agent",
    status: "running",
    ...overrides,
  };
}

function byId(...nodes: SessionNode[]): Record<string, SessionNode> {
  return Object.fromEntries(nodes.map((entry) => [entry.sessionId, entry]));
}

describe("footerAgentNodes", () => {
  it("shows an ordinary chat the agents it started, though it has no node", () => {
    const nodes = byId(
      node({
        sessionId: "brigade-1",
        parentSessionId: "plain-chat",
        rootConductorId: "plain-chat",
      }),
      node({
        sessionId: "grandchild",
        parentSessionId: "brigade-1",
        rootConductorId: "plain-chat",
      }),
      node({
        sessionId: "elsewhere",
        parentSessionId: "other-chat",
        rootConductorId: "other-chat",
      }),
    );

    expect(
      footerAgentNodes(nodes, undefined, ["plain-chat", null]).map(
        (entry) => entry.sessionId,
      ),
    ).toEqual(["brigade-1"]);
  });

  it("finds them under the chat's pre-promotion alias too", () => {
    const nodes = byId(
      node({ sessionId: "brigade-1", parentSessionId: "draft-id" }),
    );

    expect(
      footerAgentNodes(nodes, undefined, ["real-id", "draft-id"]),
    ).toHaveLength(1);
  });

  it("shows nothing when the chat has neither a node nor an id", () => {
    const nodes = byId(node({ sessionId: "brigade-1", parentSessionId: "x" }));

    expect(footerAgentNodes(nodes, undefined, [undefined, ""])).toEqual([]);
  });

  it("keeps a conductor's whole brigade, children of its orchestrators included", () => {
    const conductor = node({
      sessionId: "conductor",
      role: "conductor",
      managedBy: "ui",
      rootConductorId: "conductor",
    });
    const nodes = byId(
      conductor,
      node({
        sessionId: "orchestrator",
        role: "orchestrator",
        managedBy: "wave",
        parentSessionId: "conductor",
        rootConductorId: "conductor",
      }),
      node({
        sessionId: "worker",
        managedBy: "wave",
        parentSessionId: "orchestrator",
        rootConductorId: "conductor",
      }),
    );

    expect(
      footerAgentNodes(nodes, conductor, ["conductor"])
        .map((entry) => entry.sessionId)
        .sort(),
    ).toEqual(["orchestrator", "worker"]);
  });
});
