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

import { createUserMessage } from "@/shared/types/messages";

import { CommandError } from "../../commands/types";
import {
  enforceFlockctlSpawnAcl,
  registerFlockctlChildNode,
  resolveFlockctlSpawnParent,
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

describe("enforceFlockctlSpawnAcl", () => {
  it("logs every anonymous spawn, because with the built-in host that is all of them", () => {
    // The reading "anonymous means the operator" is a product decision, but an
    // unattributed spawn must at least be visible in the app log: the host
    // exports no AGENT_SESSION_ID, so no production call carries an actor.
    enforceFlockctlSpawnAcl({
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

  it("refuses a worker starting a worker, with the notice in the worker's own transcript", () => {
    useConductorGraphStore.getState().registerNode(node());

    let thrown: unknown;
    try {
      enforceFlockctlSpawnAcl({
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
      enforceFlockctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      }),
    ).not.toThrow();
    expect(() =>
      enforceFlockctlSpawnAcl({
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
      enforceFlockctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
        targetPersona: persona("scout"),
      }),
    ).not.toThrow();
    expect(() =>
      enforceFlockctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
        targetPersona: persona("writer"),
      }),
    ).toThrow(CommandError);
    expect(() =>
      enforceFlockctlSpawnAcl({
        actor: ACTOR_ID,
        verb: "create",
        targetLayer: "worker",
      }),
    ).toThrow(CommandError);
  });
});

describe("resolveFlockctlSpawnParent", () => {
  it("takes the named parent, else the actor, and refuses two different callers", () => {
    expect(
      resolveFlockctlSpawnParent({ actor: undefined, parentSessionId: "p" }),
    ).toBe("p");
    expect(
      resolveFlockctlSpawnParent({ actor: "a", parentSessionId: undefined }),
    ).toBe("a");
    expect(
      resolveFlockctlSpawnParent({ actor: "a", parentSessionId: "a" }),
    ).toBe("a");
    expect(
      resolveFlockctlSpawnParent({ actor: null, parentSessionId: "  " }),
    ).toBeUndefined();
    expect(() =>
      resolveFlockctlSpawnParent({ actor: "a", parentSessionId: "b" }),
    ).toThrow(CommandError);
  });
});

describe("registerFlockctlChildNode", () => {
  it("hangs a child of an ordinary chat under that chat, anchored on its running reply", () => {
    // The chat that started brigades has no node of its own; before, its
    // helpers were left unregistered and showed up as unrelated chats.
    useChatStore.setState({
      messagesBySession: {
        "plain-chat": [
          createUserMessage("split the work"),
          {
            id: "reply-1",
            role: "assistant",
            created: 1,
            content: [{ type: "text", text: "Starting." }],
          },
        ],
      },
    });

    registerFlockctlChildNode({
      parentSessionId: "plain-chat",
      sessionId: "brigade-1",
      role: "worker",
      harnessId: "claude-acp",
      displayName: "Notes writer",
      projectId: "project-7",
      modelId: "model-1",
      effort: "max",
      task: "Draft the release notes",
    });

    expect(
      useConductorGraphStore.getState().getNode("brigade-1"),
    ).toMatchObject({
      managedBy: "agent-cli",
      role: "worker",
      parentSessionId: "plain-chat",
      rootConductorId: "plain-chat",
      projectId: "project-7",
      modelId: "model-1",
      effort: "max",
      anchorMessageId: "reply-1",
      status: "starting",
    });
  });

  it("leaves the anchor to the latest reply when the parent has not answered yet", () => {
    useChatStore.setState({
      messagesBySession: { "plain-chat": [createUserMessage("go")] },
    });

    registerFlockctlChildNode({
      parentSessionId: "plain-chat",
      sessionId: "brigade-2",
      role: "worker",
      harnessId: "claude-acp",
      displayName: "Changelog checker",
    });

    expect(
      useConductorGraphStore.getState().getNode("brigade-2")?.anchorMessageId,
    ).toBeUndefined();
  });

  it("registers the child under its actor as agent-cli, and not for anonymous calls", () => {
    useConductorGraphStore.getState().registerNode(node({ role: "conductor" }));

    registerFlockctlChildNode({
      parentSessionId: ACTOR_ID,
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

    registerFlockctlChildNode({
      parentSessionId: undefined,
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
