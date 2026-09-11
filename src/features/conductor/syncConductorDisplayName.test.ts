import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";

import { useConductorGraphStore } from "./conductorGraphStore";
import { syncConductorDisplayNameFromTitle } from "./syncConductorDisplayName";
import type { SessionNode } from "./types";

function conductorNode(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: "conductor-1",
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: "Producer",
    status: "stopped",
    ...overrides,
  };
}

describe("syncConductorDisplayNameFromTitle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  });

  it("renames a conductor node from a generated chat title", () => {
    useConductorGraphStore.getState().registerNode(conductorNode());

    syncConductorDisplayNameFromTitle("conductor-1", "Refund timeout fix");

    expect(
      useConductorGraphStore.getState().getNode("conductor-1")?.displayName,
    ).toBe("Refund timeout fix");
  });

  it("leaves the role placeholder when the chat still has the default title", () => {
    useConductorGraphStore.getState().registerNode(conductorNode());

    syncConductorDisplayNameFromTitle("conductor-1", DEFAULT_CHAT_TITLE);

    expect(
      useConductorGraphStore.getState().getNode("conductor-1")?.displayName,
    ).toBe("Producer");
  });

  it("does not rewrite worker names", () => {
    useConductorGraphStore.getState().registerNode(
      conductorNode({
        sessionId: "worker-1",
        role: "worker",
        parentSessionId: "conductor-1",
        displayName: "Scout",
      }),
    );

    syncConductorDisplayNameFromTitle("worker-1", "Find every caller");

    expect(
      useConductorGraphStore.getState().getNode("worker-1")?.displayName,
    ).toBe("Scout");
  });

  it("uniquifies when another node already has the generated title", () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    useConductorGraphStore.getState().registerNode(
      conductorNode({
        sessionId: "conductor-2",
        rootConductorId: "conductor-2",
        displayName: "Refund timeout fix",
      }),
    );

    syncConductorDisplayNameFromTitle("conductor-1", "Refund timeout fix");

    expect(
      useConductorGraphStore.getState().getNode("conductor-1")?.displayName,
    ).toBe("Refund timeout fix 2");
  });
});
