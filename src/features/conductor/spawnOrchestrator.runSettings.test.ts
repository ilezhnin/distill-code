import { beforeEach, describe, expect, it, vi } from "vitest";

import { acceptFirstSend } from "@/features/chat/lib/firstWorkspaceSend";
import {
  createDeferredQueuedMessagePayload,
  admitSystemInheritedQueuedMessage,
} from "@/features/chat/lib/admittedSend";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { CreateSessionOpts } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { updateSessionTitle } from "@/features/chat/stores/chatSessionOperations";
import { useChatStore } from "@/features/chat/stores/chatStore";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";

const mocks = vi.hoisted(() => ({
  reconcileSessionRunSettings: vi.fn(async () => ({})),
}));

vi.mock("@/features/chat/lib/admittedSend", () => ({
  admitSystemInheritedQueuedMessage: vi.fn(),
  createDeferredQueuedMessagePayload: vi.fn(() => ({})),
}));
vi.mock("@/features/chat/lib/firstWorkspaceSend", () => ({
  acceptFirstSend: vi.fn(() => ({ accepted: true })),
}));
vi.mock("@/features/distillctl/commands/runtime/sessionSend", () => ({
  distillctlCrossSessionSendOptions: vi.fn(() => ({})),
}));
vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => undefined),
}));
vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projects: [] }) },
}));
vi.mock("@/features/chat/lib/runSettingsReconciler", () => ({
  reconcileSessionRunSettings: (...args: unknown[]) =>
    mocks.reconcileSessionRunSettings(...(args as [])),
}));

const { spawnConductorChildSession } = await import("./spawnOrchestrator");

const PARENT_ID = "parent-1";
const CHILD_ID = "child-1";

function conductorNode(): SessionNode {
  return {
    sessionId: PARENT_ID,
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: PARENT_ID,
    runId: null,
    harnessId: "codex-acp",
    displayName: "Producer",
    status: "running",
  };
}

describe("spawnConductorChildSession run settings", () => {
  let created: CreateSessionOpts[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateSessionTitle).mockReset().mockResolvedValue(undefined);
    vi.mocked(acceptFirstSend).mockReturnValue({
      accepted: true,
      deferred: false,
      needsName: false,
    });
    created = [];
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());
    useChatStore.setState({
      messagesBySession: {},
      enqueueTransportReadyMessage: vi.fn(),
    });
    useAgentStore.setState({ personas: [] });
    useChatSessionStore.setState({
      sessions: [
        {
          id: PARENT_ID,
          title: "Producer",
          creationState: "created",
          workingDir: "/work/project",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        },
      ],
      createSession: async (opts: CreateSessionOpts) => {
        created.push(opts);
        const child = {
          id: CHILD_ID,
          title: opts.title ?? "",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
          ...(opts.runSettings ? { desiredRunSettings: opts.runSettings } : {}),
        };
        useChatSessionStore.setState((state) => ({
          sessions: [...state.sessions, child],
        }));
        return child;
      },
    } as never);
  });

  it.each([
    true,
    false,
  ])("waits for the native worker title before first-send admission: %s", async (accepted) => {
    let persistTitle!: () => void;
    const persisted = new Promise<void>((resolve) => {
      persistTitle = resolve;
    });
    vi.mocked(updateSessionTitle).mockReturnValueOnce(persisted);
    vi.mocked(acceptFirstSend).mockReturnValue({
      accepted,
      deferred: false,
      needsName: false,
    });

    const spawning = spawnConductorChildSession({
      parentSessionId: PARENT_ID,
      role: "worker",
      displayName: "Verifier",
      task: "Inspect the example",
    });

    await vi.waitFor(() => {
      expect(updateSessionTitle).toHaveBeenCalledWith(CHILD_ID, "Verifier");
    });
    expect(acceptFirstSend).not.toHaveBeenCalled();
    expect(createDeferredQueuedMessagePayload).not.toHaveBeenCalled();
    expect(admitSystemInheritedQueuedMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().enqueueTransportReadyMessage,
    ).not.toHaveBeenCalled();
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)).toBeUndefined();

    persistTitle();
    const spawned = await spawning;

    expect(spawned.sessionId).toBe(CHILD_ID);
    expect(acceptFirstSend).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().enqueueTransportReadyMessage,
    ).toHaveBeenCalledTimes(accepted ? 0 : 1);
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)).toMatchObject({
      displayName: "Verifier",
      status: "starting",
      runId: spawned.runId,
    });
  });

  it("does not queue a first prompt when the native worker title cannot be persisted", async () => {
    const failure = new Error("Session title could not be saved");
    vi.mocked(updateSessionTitle).mockRejectedValueOnce(failure);

    await expect(
      spawnConductorChildSession({
        parentSessionId: PARENT_ID,
        role: "worker",
        displayName: "Verifier",
        task: "Inspect the example",
      }),
    ).rejects.toBe(failure);

    expect(created).toHaveLength(1);
    expect(updateSessionTitle).toHaveBeenCalledWith(CHILD_ID, "Verifier");
    expect(acceptFirstSend).not.toHaveBeenCalled();
    expect(createDeferredQueuedMessagePayload).not.toHaveBeenCalled();
    expect(admitSystemInheritedQueuedMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().enqueueTransportReadyMessage,
    ).not.toHaveBeenCalled();
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)).toBeUndefined();
    expect(
      useChatSessionStore.getState().getSession(CHILD_ID)?.userSetName,
    ).not.toBe(true);
  });

  it.each([
    true,
    false,
  ])("carries the recorded decision and logical run through first-send admission: %s", async (accepted) => {
    vi.mocked(acceptFirstSend).mockReturnValue({
      accepted,
      deferred: false,
      needsName: false,
    });
    useChatStore.setState({ enqueueTransportReadyMessage: vi.fn() });
    const spawned = await spawnConductorChildSession({
      parentSessionId: PARENT_ID,
      role: "worker",
      task: "Inspect the example",
      executorDecisionKey: "wave:example:step:0",
    });
    const expected = expect.objectContaining({
      sendOptions: {
        acpPromptMetadata: {
          executorSelection: {
            decisionKey: "wave:example:step:0",
            logicalRunId: spawned.runId,
          },
        },
      },
    });
    expect(createDeferredQueuedMessagePayload).toHaveBeenCalledWith(expected);
    if (!accepted)
      expect(admitSystemInheritedQueuedMessage).toHaveBeenCalledWith(expected);
  });

  it("opens the child on the step's effort and fast mode and keeps them as its intent", async () => {
    await spawnConductorChildSession({
      parentSessionId: PARENT_ID,
      role: "worker",
      task: "run the suite",
      executionTarget: {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "gpt-5.6-sol",
        modelName: "GPT-5.6 Sol",
      },
      runSettings: { effort: "xhigh", fast: true },
    });

    expect(created).toHaveLength(1);
    expect(created[0].runSettings).toEqual({ effort: "xhigh", fast: true });
    expect(
      useChatSessionStore.getState().getSession(CHILD_ID)?.desiredRunSettings,
    ).toEqual({ effort: "xhigh", fast: true });
    expect(mocks.reconcileSessionRunSettings).toHaveBeenCalledWith({
      sessionId: CHILD_ID,
    });
    expect(useConductorGraphStore.getState().getNode(CHILD_ID)).toMatchObject({
      effort: "xhigh",
      fast: true,
    });
  });
});
