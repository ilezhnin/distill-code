import { describe, expect, it } from "vitest";

import { useConductorGraphStore } from "./conductorGraphStore";
import { checkSpawnAllowed, sessionMaySpawn } from "./spawnAcl";
import type { SessionNode } from "./types";

describe("checkSpawnAllowed", () => {
  it("refuses a worker spawning anything, naming the facts", () => {
    expect(
      checkSpawnAllowed({ initiatorRole: "worker", targetLayer: "worker" }),
    ).toEqual({
      allowed: false,
      refusal: "layer",
      initiatorRole: "worker",
      targetLayer: "worker",
      allowedLayers: [],
    });
  });

  it("honours a persona override that forbids a default-allowed spawn", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawns: [] },
      targetLayer: "worker",
    });
    expect(check.allowed).toBe(false);
  });

  it("honours a persona override that grants a default-forbidden spawn", () => {
    expect(
      checkSpawnAllowed({
        initiatorRole: "worker",
        initiatorPersona: { spawns: ["worker"] },
        targetLayer: "worker",
      }),
    ).toEqual({ allowed: true });
  });
});

describe("named spawn allowlist (spawns_agents)", () => {
  it("allows a named target on the list, however the author spelled it", () => {
    expect(
      checkSpawnAllowed({
        initiatorRole: "conductor",
        initiatorPersona: { spawnsAgents: ["Asset Integrator", "scout"] },
        targetLayer: "worker",
        targetAgentRefs: ["asset-integrator", "unity-asset-integrator"],
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a named target off the list, naming both sides", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawnsAgents: ["scout"] },
      targetLayer: "worker",
      targetAgentRefs: ["writer"],
      targetAgentName: "Writer",
    });
    expect(check).toEqual({
      allowed: false,
      refusal: "agent",
      initiatorRole: "conductor",
      targetLayer: "worker",
      allowedLayers: ["orchestrator", "worker"],
      allowedAgents: ["scout"],
      targetAgent: "Writer",
    });
  });

  it("refuses a spawn that names no agent once an allowlist exists", () => {
    // An allowlist of named agents with an unnamed escape hatch is not an
    // allowlist.
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawnsAgents: ["scout"] },
      targetLayer: "worker",
    });
    expect(check.allowed).toBe(false);
    expect(!check.allowed && check.refusal).toBe("agent");
  });

  it("an empty allowlist refuses every named spawn", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawnsAgents: [] },
      targetLayer: "worker",
      targetAgentRefs: ["scout"],
    });
    expect(!check.allowed && check.refusal).toBe("agent");
  });
});

describe("sessionMaySpawn", () => {
  const node = (sessionId: string, role: SessionNode["role"]): SessionNode => ({
    sessionId,
    projectId: "project",
    role,
    managedBy: "wave",
    parentSessionId: role === "conductor" ? null : "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "claude-acp",
    displayName: sessionId,
    status: "running",
  });

  it("is false for a wave worker and true for its conductor and a plain chat", () => {
    useConductorGraphStore.setState({
      nodesById: {
        "conductor-1": node("conductor-1", "conductor"),
        "worker-1": node("worker-1", "worker"),
      },
    });
    expect(sessionMaySpawn("worker-1", null)).toBe(false);
    expect(sessionMaySpawn("conductor-1", null)).toBe(true);
    // No node and no persona: a chat that starts what its operator asks for.
    expect(sessionMaySpawn("plain-chat", null)).toBe(true);
    expect(sessionMaySpawn(null, undefined)).toBe(true);
    useConductorGraphStore.setState({ nodesById: {} });
  });
});
