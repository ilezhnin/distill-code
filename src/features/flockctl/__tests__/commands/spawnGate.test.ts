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

import {
  __resetAllPersonaHandoffs,
  claimPersonaHandoff,
} from "@/shared/api/acpPersonaHandoff";

import { CommandError } from "../../commands/types";
import {
  enforceFlockctlSpawnAcl,
  registerFlockctlChildNode,
  resolveFlockctlSpawnCaller,
  resolveFlockctlSpawnParent,
} from "../../commands/runtime/spawnGate";
import {
  __resetSessionTokenKeyForTests,
  sessionTokenFor,
} from "../../sessionToken";

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

describe("the operator's hold", () => {
  it("refuses a session under a held conductor's tree, whoever asks", async () => {
    const {
      emptyWaveEngineState,
      resetWaveEngineStateCache,
      setWaveEngineState,
      withConductorHold,
    } = await import("@/features/conductor/waveStore");
    resetWaveEngineStateCache();
    const conductor = node({
      sessionId: "conductor-1",
      role: "conductor",
      managedBy: "ui",
      parentSessionId: null,
    });
    useConductorGraphStore.setState({
      nodesById: { "conductor-1": conductor, [ACTOR_ID]: node() },
    });
    const spawn = (actor: string) => () =>
      enforceFlockctlSpawnAcl({
        actor,
        verb: "create",
        targetLayer: "worker",
      });
    // Not held: the conductor may start a worker.
    expect(spawn("conductor-1")).not.toThrow();

    setWaveEngineState(
      withConductorHold(emptyWaveEngineState(), "conductor-1", true),
    );
    for (const actor of ["conductor-1", ACTOR_ID]) {
      let refusal: unknown;
      try {
        spawn(actor)();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(CommandError);
      expect((refusal as CommandError).code).toBe("spawn_not_allowed");
      expect((refusal as CommandError).message).toContain("on hold");
    }
    // Another conductor's tree is untouched.
    useConductorGraphStore.setState({
      nodesById: {
        "conductor-2": { ...conductor, sessionId: "conductor-2" },
      },
    });
    expect(spawn("conductor-2")).not.toThrow();
    resetWaveEngineStateCache();
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

describe("resolveFlockctlSpawnCaller", () => {
  const refusal = async (
    args: Parameters<typeof resolveFlockctlSpawnCaller>[0],
  ): Promise<CommandError> => {
    try {
      await resolveFlockctlSpawnCaller(args);
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      return error as CommandError;
    }
    throw new Error("the call was not refused");
  };

  beforeEach(() => {
    __resetSessionTokenKeyForTests();
    __resetAllPersonaHandoffs();
  });

  it("reads the operator's own terminal as before: no proof asked", async () => {
    expect(
      await resolveFlockctlSpawnCaller({
        actor: undefined,
        fromAgent: false,
        parentSessionId: undefined,
        sessionToken: undefined,
      }),
    ).toEqual({ actor: undefined, parentSessionId: undefined });
    expect(
      await resolveFlockctlSpawnCaller({
        actor: undefined,
        fromAgent: undefined,
        parentSessionId: "conductor-1",
        sessionToken: undefined,
      }),
    ).toEqual({ actor: "conductor-1", parentSessionId: "conductor-1" });
  });

  it("refuses an agent's call that names nobody: it is not the operator", async () => {
    const error = await refusal({
      actor: undefined,
      fromAgent: true,
      parentSessionId: undefined,
      sessionToken: undefined,
    });
    expect(error.code).toBe("spawn_not_allowed");
    expect(error.message).toContain("--session-token");
  });

  it("refuses an agent's call that names a session without proving it", async () => {
    // The worker that may start nobody named its conductor.
    const error = await refusal({
      actor: undefined,
      fromAgent: true,
      parentSessionId: "conductor-1",
      sessionToken: undefined,
    });
    expect(error.code).toBe("spawn_not_allowed");
    expect(error.message).toContain('"conductor-1"');
    expect(error.message).toContain("--session-token");
  });

  it("sends the named chat its context again, in case it is the caller that lost it", async () => {
    expect(
      claimPersonaHandoff("conductor-1", "claude-acp", "persona", "app"),
    ).not.toBeNull();
    expect(
      claimPersonaHandoff("conductor-1", "claude-acp", "persona", "app"),
    ).toBeNull();
    await refusal({
      actor: undefined,
      fromAgent: true,
      parentSessionId: "conductor-1",
      sessionToken: undefined,
    });
    expect(
      claimPersonaHandoff("conductor-1", "claude-acp", "persona", "app"),
    ).not.toBeNull();
  });

  it("takes the session a token proves as the caller", async () => {
    const token = await sessionTokenFor("conductor-1");
    // Started under itself: its child.
    expect(
      await resolveFlockctlSpawnCaller({
        actor: undefined,
        fromAgent: true,
        parentSessionId: "conductor-1",
        sessionToken: token,
      }),
    ).toEqual({ actor: "conductor-1", parentSessionId: "conductor-1" });
    // No parent named: an independent chat, still checked as its caller.
    expect(
      await resolveFlockctlSpawnCaller({
        actor: undefined,
        fromAgent: true,
        parentSessionId: undefined,
        sessionToken: token,
      }),
    ).toEqual({ actor: "conductor-1", parentSessionId: undefined });
  });

  it("refuses a token that is not this app's, and one used for another session", async () => {
    const forged = await refusal({
      actor: undefined,
      fromAgent: true,
      parentSessionId: "conductor-1",
      // Shaped like a token, with a digest nobody signed.
      sessionToken: `conductor-1.${"0".repeat(16)}`,
    });
    expect(forged.code).toBe("spawn_not_allowed");

    // A real token, its owner naming another session as the parent.
    const borrowed = await refusal({
      actor: undefined,
      fromAgent: true,
      parentSessionId: "conductor-1",
      sessionToken: await sessionTokenFor(ACTOR_ID),
    });
    expect(borrowed.code).toBe("invalid_args");
    expect(borrowed.message).toContain("only start sessions under itself");
  });

  it("lets a session hang what it starts under its own executors", async () => {
    // The conductor's dispatcher starts readers under the step that
    // launched it, with the conductor's token in its environment.
    useConductorGraphStore.setState({
      nodesById: {
        "conductor-1": node({
          sessionId: "conductor-1",
          role: "conductor",
          managedBy: "ui",
          parentSessionId: null,
        }),
        [ACTOR_ID]: node(),
        "reader-1": node({
          sessionId: "reader-1",
          parentSessionId: ACTOR_ID,
        }),
        elsewhere: node({
          sessionId: "elsewhere",
          parentSessionId: "conductor-2",
          rootConductorId: "conductor-2",
        }),
      },
    });
    const token = await sessionTokenFor("conductor-1");
    for (const parent of [ACTOR_ID, "reader-1"]) {
      expect(
        await resolveFlockctlSpawnCaller({
          actor: undefined,
          fromAgent: true,
          parentSessionId: parent,
          sessionToken: token,
        }),
        // Checked as the conductor, hung where the work is.
      ).toEqual({ actor: "conductor-1", parentSessionId: parent });
    }
    // Not under another conductor's executor, and not the other way up:
    // an executor's token does not reach its conductor.
    for (const [parent, owner] of [
      ["elsewhere", "conductor-1"],
      ["conductor-1", ACTOR_ID],
    ]) {
      const error = await refusal({
        actor: undefined,
        fromAgent: true,
        parentSessionId: parent,
        sessionToken: await sessionTokenFor(owner),
      });
      expect(error.code).toBe("invalid_args");
    }
  });

  it("says where a script finds the token when it refuses a call without one", async () => {
    const error = await refusal({
      actor: undefined,
      fromAgent: true,
      parentSessionId: undefined,
      sessionToken: undefined,
    });
    expect(error.message).toContain("FLOCK_SESSION_TOKEN");
  });

  it("keeps a harness's own exported identity working without a token", async () => {
    expect(
      await resolveFlockctlSpawnCaller({
        actor: ACTOR_ID,
        fromAgent: true,
        parentSessionId: undefined,
        sessionToken: undefined,
      }),
    ).toEqual({ actor: ACTOR_ID, parentSessionId: ACTOR_ID });
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
