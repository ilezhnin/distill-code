import { describe, expect, it } from "vitest";
import {
  footerAgentNodes,
  isNestedExecutorSession,
  nestedExecutorSessionIdSet,
} from "./sessionVisibility";
import type { SessionNode } from "./types";

function node(sessionId: string, role: SessionNode["role"]): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role,
    managedBy: "ui",
    parentSessionId: role === "conductor" ? null : "conductor-1",
    rootConductorId: "conductor-1",
    runId: role === "orchestrator" ? "run-1" : null,
    harnessId: "goose",
    displayName: sessionId,
    status: "running",
  };
}

describe("sessionVisibility", () => {
  it("hides orchestrator and worker sessions from the sidebar", () => {
    const nestedIds = nestedExecutorSessionIdSet({
      "conductor-1": node("conductor-1", "conductor"),
      "orch-1": node("orch-1", "orchestrator"),
      "worker-1": node("worker-1", "worker"),
    });

    expect(isNestedExecutorSession({ id: "conductor-1" }, nestedIds)).toBe(
      false,
    );
    expect(isNestedExecutorSession({ id: "orch-1" }, nestedIds)).toBe(true);
    expect(
      isNestedExecutorSession(
        { id: "backend-worker", clientSessionId: "worker-1" },
        nestedIds,
      ),
    ).toBe(true);
  });

  it("lists descendant orchestrators and workers in the conductor footer", () => {
    const worker: SessionNode = {
      ...node("worker-1", "worker"),
      parentSessionId: "orch-1",
      rootConductorId: "conductor-1",
    };
    const orchestrator = node("orch-1", "orchestrator");
    const conductor = node("conductor-1", "conductor");
    const nodes = {
      "conductor-1": conductor,
      "orch-1": orchestrator,
      "worker-1": worker,
    };
    const footer = footerAgentNodes(nodes, conductor);
    expect(footer.map((item) => item.sessionId).sort()).toEqual([
      "orch-1",
      "worker-1",
    ]);
    expect(
      footerAgentNodes(nodes, orchestrator).map((item) => item.sessionId),
    ).toEqual(["worker-1"]);
  });
});
