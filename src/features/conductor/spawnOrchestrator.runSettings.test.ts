import { beforeEach, describe, expect, it, vi } from "vitest";

import { acceptFirstSend } from "@/features/chat/lib/firstWorkspaceSend";
import {
  createDeferredQueuedMessagePayload,
  admitSystemInheritedQueuedMessage,
} from "@/features/chat/lib/admittedSend";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { CreateSessionOpts } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
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
    vi.mocked(acceptFirstSend).mockReturnValue({ accepted: true } as never);
    created = [];
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());
    useChatStore.setState({ messagesBySession: {} });
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
  ])("carries the recorded decision and logical run through first-send admission: %s", async (accepted) => {
    vi.mocked(acceptFirstSend).mockReturnValue({ accepted } as never);
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
