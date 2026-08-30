import { beforeEach, describe, expect, it } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import type { Persona } from "@/shared/types/agents";

import { CommandError } from "../../commands/types";
import {
  enforceBerdctlSpawnAcl,
  forkTargetLayer,
  registerBerdctlChildNode,
} from "../../commands/runtime/spawnGate";

const ACTOR_ID = "20260830_7";

function node(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: ACTOR_ID,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: "run-1",
    harnessId: "goose",
    displayName: "Scout · docs",
    status: "running",
    ...overrides,
  };
}

function persona(id: string, spawns?: Persona["spawns"]): Persona {
  return {
    id,
    displayName: id,
    systemPrompt: "",
    isBuiltin: false,
    writable: true,
    ...(spawns !== undefined ? { spawns } : {}),
  };
}

function actorNotices(): string[] {
  return (useChatStore.getState().messagesBySession[ACTOR_ID] ?? []).flatMap(
    (message) =>
      message.content.flatMap((block) =>
        block.type === "systemNotification" ? [block.text] : [],
      ),
  );
}

beforeEach(async () => {
  const { i18n } = await import("@/shared/i18n");
  await i18n.loadNamespaces("chat");
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  useChatStore.setState({ messagesBySession: {} });
  useAgentStore.setState({ personas: [] });
});

describe("enforceBerdctlSpawnAcl", () => {
  it("lets an anonymous call through — that is the operator", () => {
    expect(() =>
      enforceBerdctlSpawnAcl({ actor: undefined, targetLayer: "worker" }),
    ).not.toThrow();
  });

  it("lets an actor with no graph node through — an ordinary chat acts for the operator", () => {
    expect(() =>
      enforceBerdctlSpawnAcl({ actor: ACTOR_ID, targetLayer: "worker" }),
    ).not.toThrow();
  });

  it("refuses a worker starting a worker, with the notice in the worker's own transcript", () => {
    useConductorGraphStore.getState().registerNode(node());

    let thrown: unknown;
    try {
      enforceBerdctlSpawnAcl({ actor: ACTOR_ID, targetLayer: "worker" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code).toBe("spawn_not_allowed");
    // D5: the refusal is already visible where the operator is looking.
    expect(actorNotices().length).toBeGreaterThan(0);
  });

  it("honours a persona spawns override on the actor's node", () => {
    useConductorGraphStore
      .getState()
      .registerNode(node({ personaId: "trusted" }));
    useAgentStore.setState({ personas: [persona("trusted", ["worker"])] });

    expect(() =>
      enforceBerdctlSpawnAcl({ actor: ACTOR_ID, targetLayer: "worker" }),
    ).not.toThrow();
    expect(() =>
      enforceBerdctlSpawnAcl({ actor: ACTOR_ID, targetLayer: "orchestrator" }),
    ).toThrow(CommandError);
  });

  it("lets a conductor start workers, per the layer default", () => {
    useConductorGraphStore.getState().registerNode(node({ role: "conductor" }));
    expect(() =>
      enforceBerdctlSpawnAcl({ actor: ACTOR_ID, targetLayer: "worker" }),
    ).not.toThrow();
  });
});

describe("forkTargetLayer", () => {
  it("is the source node's own rank, worker for plain sessions", () => {
    expect(forkTargetLayer("no-node")).toBe("worker");
    useConductorGraphStore
      .getState()
      .registerNode(node({ sessionId: "orch-1", role: "orchestrator" }));
    expect(forkTargetLayer("orch-1")).toBe("orchestrator");
  });
});

describe("registerBerdctlChildNode", () => {
  it("registers the child under its actor as agent-cli, and not for anonymous calls", () => {
    useConductorGraphStore.getState().registerNode(node({ role: "conductor" }));

    registerBerdctlChildNode({
      actor: ACTOR_ID,
      sessionId: "child-1",
      role: "worker",
      harnessId: "claude-acp",
      displayName: "Triage",
      task: "Triage the failing nightly build",
    });
    const child = useConductorGraphStore.getState().getNode("child-1");
    expect(child?.managedBy).toBe("agent-cli");
    expect(child?.parentSessionId).toBe(ACTOR_ID);
    expect(child?.rootConductorId).toBe("conductor-1");
    expect(child?.role).toBe("worker");

    registerBerdctlChildNode({
      actor: undefined,
      sessionId: "child-2",
      role: "worker",
      harnessId: "goose",
      displayName: "Plain",
    });
    expect(
      useConductorGraphStore.getState().getNode("child-2"),
    ).toBeUndefined();
  });
});
