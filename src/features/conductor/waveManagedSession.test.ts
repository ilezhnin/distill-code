import { beforeEach, describe, expect, it } from "vitest";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";
import { isWaveManagedSession } from "./waveManagedSession";

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "p",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "c",
    rootConductorId: "c",
    runId: null,
    harnessId: "goose",
    displayName: "Worker",
    status: "running",
    ...overrides,
  };
}

describe("isWaveManagedSession", () => {
  beforeEach(() => {
    useConductorGraphStore.setState({ nodesById: {} });
  });

  it("is true only for a child the wave engine owns", () => {
    useConductorGraphStore.setState({
      nodesById: {
        wave: node({ sessionId: "wave", managedBy: "wave" }),
        ui: node({ sessionId: "ui", managedBy: "ui" }),
        cli: node({ sessionId: "cli", managedBy: "agent-cli" }),
      },
    });

    expect(isWaveManagedSession("wave")).toBe(true);
    expect(isWaveManagedSession("ui")).toBe(false);
    expect(isWaveManagedSession("cli")).toBe(false);
  });

  it("is false for a session the graph has never heard of", () => {
    // Every ordinary chat is one of these; it must never read as managed.
    expect(isWaveManagedSession("plain-chat")).toBe(false);
    expect(isWaveManagedSession(null)).toBe(false);
    expect(isWaveManagedSession(undefined)).toBe(false);
  });
});
