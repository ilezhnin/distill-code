import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { Persona } from "@/shared/types/agents";

import { useConductorGraphStore } from "./conductorGraphStore";
import { SpawnAclDeniedError } from "./spawnAcl";
import type { SessionNode } from "./types";

// The ACL check runs before anything is created; these mocks only keep the
// module graph loadable, none of them is reached by a refused spawn.
vi.mock("@/features/chat/lib/admittedSend", () => ({
  admitSystemInheritedQueuedMessage: vi.fn(),
  createDeferredQueuedMessagePayload: vi.fn(),
}));
vi.mock("@/features/chat/lib/firstWorkspaceSend", () => ({
  acceptFirstSend: vi.fn(() => ({ accepted: true })),
}));
vi.mock("@/features/berdctl/commands/runtime/sessionSend", () => ({
  berdctlCrossSessionSendOptions: vi.fn(() => ({})),
}));
vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => undefined),
}));
vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projects: [] }) },
}));

const { spawnConductorChildSession } = await import("./spawnOrchestrator");

const PARENT_ID = "parent-1";

function parentSession(overrides: Record<string, unknown> = {}) {
  return {
    id: PARENT_ID,
    title: "Producer",
    creationState: "created",
    workingDir: "/work/project",
    ...overrides,
  } as never;
}

function parentNode(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: PARENT_ID,
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: PARENT_ID,
    runId: null,
    harnessId: "goose",
    displayName: "Producer",
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

function parentNotices(): string[] {
  return (useChatStore.getState().messagesBySession[PARENT_ID] ?? []).flatMap(
    (message) =>
      message.content.flatMap((block) =>
        block.type === "systemNotification" ? [block.text] : [],
      ),
  );
}

/** Marker thrown by the stubbed createSession: the ACL let the spawn pass. */
const REACHED_CREATE = "reached-create";

describe("spawnConductorChildSession spawn ACL", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({ messagesBySession: {} });
    useAgentStore.setState({ personas: [] });
    useChatSessionStore.setState({
      sessions: [parentSession()],
      // Failing loudly at createSession is how these tests observe that the
      // ACL allowed the spawn without standing up the whole session pipeline.
      createSession: async () => {
        throw new Error(REACHED_CREATE);
      },
    } as never);
  });

  it("refuses a worker-layer parent spawning a worker, visibly", async () => {
    useConductorGraphStore
      .getState()
      .registerNode(parentNode({ role: "worker", displayName: "Scout" }));

    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        task: "do something",
      }),
    ).rejects.toBeInstanceOf(SpawnAclDeniedError);

    const notices = parentNotices().join("\n");
    expect(notices).toContain("Scout");
    expect(notices).toContain("worker");
    expect(notices).toContain("nothing was started");
  });

  it("honours a conductor persona override that forbids spawning", async () => {
    useAgentStore.setState({ personas: [persona("locked-conductor", [])] });
    useConductorGraphStore
      .getState()
      .registerNode(parentNode({ personaId: "locked-conductor" }));

    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        task: "do something",
      }),
    ).rejects.toBeInstanceOf(SpawnAclDeniedError);
    expect(parentNotices().length).toBe(1);
  });

  it("lets a conductor spawn a worker by default", async () => {
    useConductorGraphStore.getState().registerNode(parentNode());

    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        task: "do something",
      }),
    ).rejects.toThrow(REACHED_CREATE);
    expect(parentNotices()).toEqual([]);
  });

  it("refuses a conductor spawning outside its layers' targets", async () => {
    useConductorGraphStore
      .getState()
      .registerNode(parentNode({ role: "orchestrator" }));

    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "orchestrator",
        task: "do something",
      }),
    ).rejects.toBeInstanceOf(SpawnAclDeniedError);
  });

  it("treats a node-less wave spawn as conductor-initiated", async () => {
    // The conductor draft-id remap can leave the node unmapped for a tick;
    // a wave spawn must not be refused over that race.
    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        managedBy: "wave",
        waveId: "wave-1",
        stepIndex: 0,
        task: "do something",
      }),
    ).rejects.toThrow(REACHED_CREATE);
  });

  it("treats a node-less non-wave parent as a plain chat and refuses", async () => {
    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        task: "do something",
      }),
    ).rejects.toBeInstanceOf(SpawnAclDeniedError);
  });

  it("reads the persona override from the parent session when the node has none", async () => {
    useAgentStore.setState({
      personas: [persona("session-persona", ["worker"])],
    });
    useConductorGraphStore
      .getState()
      .registerNode(parentNode({ role: "worker" }));
    useChatSessionStore.setState({
      sessions: [parentSession({ personaId: "session-persona" })],
    } as never);

    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        task: "do something",
      }),
    ).rejects.toThrow(REACHED_CREATE);
  });
});
