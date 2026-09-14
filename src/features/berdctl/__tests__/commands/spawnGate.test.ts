import { beforeEach, describe, expect, it, vi } from "vitest";

const logRendererEvent = vi.hoisted(() =>
  vi.fn((_level: string, _message: string) => Promise.resolve()),
);
vi.mock("@/shared/api/rendererLog", () => ({ logRendererEvent }));

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
  logRendererEvent.mockClear();
});

describe("enforceBerdctlSpawnAcl", () => {
  it("lets an anonymous call through — that is the operator", () => {
    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: undefined,
        verb: "create",
        targetLayer: "worker",
      }),
    ).not.toThrow();
  });

  it("logs every anonymous spawn, because with the built-in host that is all of them", () => {
    // The reading "anonymous means the operator" is a product decision, but an
    // unattributed spawn must at least be visible in the app log: the host
    // exports no AGENT_SESSION_ID, so no production call carries an actor.
    enforceBerdctlSpawnAcl({
      actor: null,
      verb: "fork",
      targetLayer: "orchestrator",
      targetPersona: {
        id: "producer",
        displayName: "Producer",
        systemPrompt: "",
        isBuiltin: false,
        writable: true,
      },
    });

    expect(logRendererEvent).toHaveBeenCalledTimes(1);
    const [level, message] = logRendererEvent.mock.calls[0];
    expect(level).toBe("info");
    expect(message).toContain("session fork");
    expect(message).toContain("orchestrator");
    expect(message).toContain("Producer");
    expect(message).toContain("AGENT_SESSION_ID");
  });

  it("does not log when the call carries an actor", () => {
    enforceBerdctlSpawnAcl({
      actor: ACTOR_ID,
      verb: "create",
      targetLayer: "worker",
    });
    expect(logRendererEvent).not.toHaveBeenCalled();
  });

  it("lets an actor with no graph node through — an ordinary chat acts for the operator", () => {
    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      }),
    ).not.toThrow();
  });

  it("refuses a worker starting a worker, with the notice in the worker's own transcript", () => {
    useConductorGraphStore.getState().registerNode(node());

    let thrown: unknown;
    try {
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      });
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
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      }),
    ).not.toThrow();
    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "orchestrator",
      }),
    ).toThrow(CommandError);
  });

  it("enforces a named allowlist: listed persona passes, unlisted and unnamed refuse", () => {
    useConductorGraphStore
      .getState()
      .registerNode(node({ role: "conductor", personaId: "producer" }));
    useAgentStore.setState({
      personas: [
        { ...persona("producer"), spawnsAgents: ["scout"] },
        persona("scout"),
        persona("writer"),
      ],
    });

    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
        targetPersona: persona("scout"),
      }),
    ).not.toThrow();
    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
        targetPersona: persona("writer"),
      }),
    ).toThrow(CommandError);
    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      }),
    ).toThrow(CommandError);
  });

  it("lets a conductor start workers, per the layer default", () => {
    useConductorGraphStore.getState().registerNode(node({ role: "conductor" }));
    expect(() =>
      enforceBerdctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      }),
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
