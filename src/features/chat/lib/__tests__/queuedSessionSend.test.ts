import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  acquireExistingSessionForBackgroundSend,
  sendQueuedPromptToExistingSessionInBackground,
} from "@/features/chat/lib/queuedSessionSend";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";

const mocks = vi.hoisted(() => ({
  loadSessionMessages: vi.fn(),
  sendPromptInBackground: vi.fn(),
  loadWorkspaceInstructionFiles: vi.fn(),
  listSkills: vi.fn(),
  resolveSessionCwd: vi.fn(),
  acpPrepareSession: vi.fn(),
  listProjects: vi.fn(),
  listProjectDocuments: vi.fn(),
}));

vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages: (...args: unknown[]) =>
    mocks.loadSessionMessages(...args),
}));

vi.mock("@/features/chat/lib/backgroundSend", () => ({
  sendPromptInBackground: (...args: unknown[]) =>
    mocks.sendPromptInBackground(...args),
}));

vi.mock("@/features/chat/api/workspaceContext", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/api/workspaceContext")
  >()),
  loadWorkspaceInstructionFiles: (...args: unknown[]) =>
    mocks.loadWorkspaceInstructionFiles(...args),
}));

vi.mock("@/features/skills/api/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/skills/api/skills")>()),
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
}));

vi.mock(
  "@/features/projects/lib/sessionCwdSelection",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/projects/lib/sessionCwdSelection")
    >()),
    resolveSessionCwd: (...args: unknown[]) => mocks.resolveSessionCwd(...args),
  }),
);

vi.mock("@/shared/api/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/acp")>()),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
}));

vi.mock("@/features/projects/api/projects", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/projects/api/projects")
  >()),
  listProjects: (...args: unknown[]) => mocks.listProjects(...args),
}));

vi.mock("@/shared/api/projectStore", () => ({
  listProjectDocuments: (...args: unknown[]) =>
    mocks.listProjectDocuments(...args),
  readProjectDocument: vi.fn(),
  writeProjectDocument: vi.fn(),
}));

const SESSION_ID = "draft-session";

function seedSession(creationState?: "pending" | "failed"): void {
  useChatSessionStore.setState({
    sessions: [
      {
        id: SESSION_ID,
        title: "New chat",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        messageCount: 0,
        executionTarget: { harnessId: "goose" },
        clientSessionId: SESSION_ID,
        ...(creationState ? { creationState } : {}),
      },
    ],
    hasHydratedSessions: true,
  });
}

function agentBuilderRecord(): QueuedMessageRecord & {
  kind: "transport-ready";
} {
  return {
    kind: "transport-ready",
    recordId: "builder-record",
    payload: {
      text: "make a reviewer",
      persona: { kind: "inherit" },
      sendOptions: { chips: [{ label: "agent-builder", type: "skill" }] },
    },
  };
}

function queuedRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "record-1",
    payload: { text: "first prompt", persona: { kind: "inherit" } },
  };
}

describe("acquireExistingSessionForBackgroundSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    mocks.loadSessionMessages.mockResolvedValue(true);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
    });
  });

  it("holds the dispatch target across hydration so no other sender dispatches into the load", async () => {
    seedSession();
    let resolveHydration!: (loaded: boolean) => void;
    mocks.loadSessionMessages.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveHydration = resolve;
      }),
    );

    const acquisition = acquireExistingSessionForBackgroundSend(SESSION_ID);

    // Notifications arriving during `session/load` are treated as replay, so a
    // second sender must see this window as contended rather than free.
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
    expect(acquireSessionDispatchTarget(SESSION_ID).status).toBe("contended");

    resolveHydration(true);
    await expect(acquisition).resolves.toMatchObject({ status: "acquired" });
  });

  it("releases the dispatch target when hydration fails", async () => {
    seedSession();
    mocks.loadSessionMessages.mockResolvedValue(false);

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).rejects.toThrow(/load the target session/);

    // A leaked lease would make every later send look like a running dispatch.
    const retry = acquireSessionDispatchTarget(SESSION_ID);
    expect(retry.status).toBe("acquired");
    retry.release?.();
  });

  it("releases the dispatch target when the session disappears during hydration", async () => {
    seedSession();
    mocks.loadSessionMessages.mockImplementation(async () => {
      useChatSessionStore.setState({ sessions: [] });
      return true;
    });

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toEqual({ status: "session-missing" });

    seedSession();
    const retry = acquireSessionDispatchTarget(SESSION_ID);
    expect(retry.status).toBe("acquired");
    retry.release?.();
  });
});

describe("sendQueuedPromptToExistingSessionInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    mocks.loadSessionMessages.mockResolvedValue(true);
    mocks.sendPromptInBackground.mockResolvedValue(undefined);
    mocks.loadWorkspaceInstructionFiles.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.resolveSessionCwd.mockResolvedValue("/tmp/project");
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    mocks.listProjects.mockResolvedValue([]);
    mocks.listProjectDocuments.mockResolvedValue([]);
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useMemoryStore.setState({
      entries: [],
      archived: [],
      waveExecutorSessionIds: [],
    });
    useProjectStore.setState({ projects: [] });
    window.localStorage.clear();
  });

  it("rejects an Agent Builder send until the session owns a prepared draft target", async () => {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        intent: "build-agent" as const,
        agentBuilderOpen: true,
      })),
    }));
    const beforeUserMessageCommitted = vi.fn();

    const error = await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      agentBuilderRecord(),
      beforeUserMessageCommitted,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreCommitSendRejectedError);
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
    expect(beforeUserMessageCommitted).not.toHaveBeenCalled();
  });

  const PROJECT = {
    id: "p-1",
    path: "/projects/quarp",
    name: "Quarp",
    description: "",
    prompt: "Follow Quarp's project instructions.",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: ["/work/quarp"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
  };

  function dispatchedExecutionPrompt(): string {
    const options = mocks.sendPromptInBackground.mock.calls[0]?.[4] as
      | { executionSystemPrompt?: string }
      | undefined;
    return options?.executionSystemPrompt ?? "";
  }

  async function seedProjectMemory(): Promise<void> {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        projectId: "p-1",
      })),
    }));
    useProjectStore.setState({ projects: [PROJECT] });
    mocks.listProjects.mockResolvedValue([PROJECT]);
    useMemoryStore.setState({
      entries: [
        {
          id: "m-1",
          text: "A standing memory.",
          scope: "global",
          projectId: null,
          createdAt: 0,
        },
      ],
    });
  }

  it("keeps memory away from an evicted wave executor while carrying project instructions", async () => {
    await seedProjectMemory();
    useMemoryStore.setState({ waveExecutorSessionIds: [SESSION_ID] });

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedRecord(),
    );

    const prompt = dispatchedExecutionPrompt();
    expect(prompt).toContain("Follow Quarp's project instructions.");
    expect(prompt).not.toContain("<memory>");
    expect(prompt).not.toContain("A standing memory.");
  });
});
