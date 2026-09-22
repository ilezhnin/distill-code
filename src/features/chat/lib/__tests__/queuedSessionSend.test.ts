import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  acquireExistingSessionForBackgroundSend,
  queuedDispatchTargetMatches,
  sendQueuedPromptToExistingSessionInBackground,
} from "@/features/chat/lib/queuedSessionSend";
import { SessionDispatchCreationIncompleteError } from "@/features/chat/lib/sessionDispatchAcquisition";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  PROJECT_RESEARCH_POINTER_PROMPT,
  resetProjectResearchPresenceForTests,
} from "@/features/memory/lib/projectResearchPrompt";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resetRootInstructionsForTests } from "@/features/chat/lib/rootInstructionsPrompt";

const mocks = vi.hoisted(() => ({
  loadSessionMessages: vi.fn(),
  sendPromptInBackground: vi.fn(),
  loadWorkspaceInstructionFiles: vi.fn(),
  listSkills: vi.fn(),
  resolveSessionCwd: vi.fn(),
  acpPrepareSession: vi.fn(),
  listProjects: vi.fn(),
  listProjectDocuments: vi.fn(),
  getDistillRoot: vi.fn(),
  readDistillInstructions: vi.fn(),
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

vi.mock("@/shared/api/distillStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/distillStore")>()),
  getDistillRoot: (...args: unknown[]) => mocks.getDistillRoot(...args),
  readDistillInstructions: (...args: unknown[]) =>
    mocks.readDistillInstructions(...args),
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

  it.each([
    "pending",
    "failed",
  ] as const)("holds a %s draft session instead of hydrating it", async (creationState) => {
    seedSession(creationState);

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toEqual({ status: "creation-incomplete", creationState });
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
  });

  it("acquires a dispatch target once creation has completed", async () => {
    seedSession();

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toMatchObject({ status: "acquired" });
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
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

  it("hydrates first and leases the replayed target when the session has none yet", async () => {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTarget: undefined,
      })),
    }));
    // distillctl can address a session this renderer has never activated; its
    // execution target arrives with the `session/load` replay itself.
    mocks.loadSessionMessages.mockImplementation(async () => {
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          executionTarget: { harnessId: "goose" },
        })),
      }));
      return true;
    });

    const acquisition =
      await acquireExistingSessionForBackgroundSend(SESSION_ID);

    expect(acquisition).toMatchObject({
      status: "acquired",
      target: { harnessId: "goose" },
    });
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
    if (acquisition.status === "acquired") acquisition.release();
  });

  it("reports unresolved only after hydration had its chance to supply a target", async () => {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTarget: undefined,
      })),
    }));

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toEqual({ status: "unresolved" });
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
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

describe("queuedDispatchTargetMatches", () => {
  const leased = {
    harnessId: "codex-acp",
    modelProviderId: "codex-acp",
    modelId: "gpt-5.6-sol",
    modelName: "GPT-5.6 Sol",
  };

  it("dispatches to a session whose replay reports the leased model with a folded effort", () => {
    expect(
      queuedDispatchTargetMatches(
        { ...leased, modelId: "gpt-5.6-sol[low]", modelName: "GPT-5.6 Sol" },
        leased,
      ),
    ).toBe(true);
  });

  it("treats a different model as a newer selection", () => {
    expect(
      queuedDispatchTargetMatches(
        { ...leased, modelId: "gpt-5.6-luna", modelName: "GPT-5.6 Luna" },
        leased,
      ),
    ).toBe(false);
  });

  it("treats the same model on another harness as a newer selection", () => {
    expect(
      queuedDispatchTargetMatches(
        { ...leased, harnessId: "grok-acp", modelProviderId: "grok-acp" },
        leased,
      ),
    ).toBe(false);
  });
});

describe("sendQueuedPromptToExistingSessionInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    resetRootInstructionsForTests();
    resetProjectResearchPresenceForTests();
    mocks.loadSessionMessages.mockResolvedValue(true);
    mocks.sendPromptInBackground.mockResolvedValue(undefined);
    mocks.loadWorkspaceInstructionFiles.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.resolveSessionCwd.mockResolvedValue("/tmp/project");
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    mocks.listProjects.mockResolvedValue([]);
    mocks.listProjectDocuments.mockResolvedValue([]);
    mocks.getDistillRoot.mockResolvedValue(null);
    mocks.readDistillInstructions.mockResolvedValue({
      "prompt.md": null,
      "security-posture.md": null,
      "user.md": null,
      "lore.md": null,
      "research/index.md": null,
    });
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

  it("rejects a send to a creating session without committing anything", async () => {
    seedSession("pending");
    const beforeUserMessageCommitted = vi.fn();

    const error = await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedRecord(),
      beforeUserMessageCommitted,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionDispatchCreationIncompleteError);
    // The drains swallow pre-commit rejections instead of parking the head as
    // a failed record and toasting, which is what keeps the message queued.
    expect(error).toBeInstanceOf(PreCommitSendRejectedError);
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
    expect(beforeUserMessageCommitted).not.toHaveBeenCalled();
  });

  const ROOT = "/tmp/distill-root";
  const RESEARCH_PROJECT = {
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

  async function seedOperatorAndResearch(): Promise<void> {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        projectId: "p-1",
      })),
    }));
    useProjectStore.setState({ projects: [RESEARCH_PROJECT] });
    mocks.listProjects.mockResolvedValue([RESEARCH_PROJECT]);
    mocks.getDistillRoot.mockResolvedValue({
      root: ROOT,
      forcedByEnvironment: false,
    });
    mocks.readDistillInstructions.mockResolvedValue({
      "prompt.md": "Be brief.",
      "security-posture.md": "Never disclose secrets.",
      "user.md": "The operator prefers short answers.",
      "lore.md": "We built Distill together.",
      "research/index.md": "| 01 | topic | decided | never |",
    });
    mocks.listProjectDocuments.mockResolvedValue(["index.md"]);
    // The first queued send must discover the index without a prior view.
  }

  function seedWaveChild(): void {
    useConductorGraphStore.setState({
      nodesById: {
        [SESSION_ID]: {
          sessionId: SESSION_ID,
          projectId: "p-1",
          role: "worker",
          managedBy: "wave",
          parentSessionId: "conductor-1",
          rootConductorId: "conductor-1",
          runId: "run-1",
          harnessId: "goose",
          displayName: "Scout · step",
          status: "running",
        },
      },
      reportsByRunId: {},
    });
  }

  it("carries operator-profile on a plain queued chat", async () => {
    await seedOperatorAndResearch();

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedRecord(),
    );

    const prompt = dispatchedExecutionPrompt();
    expect(prompt).toContain("Follow Quarp's project instructions.");
    expect(prompt).toContain("<operator-profile>");
    expect(prompt).toContain("The operator prefers short answers.");
    expect(prompt).toContain(PROJECT_RESEARCH_POINTER_PROMPT);
  });

  it("keeps operator blocks away from a wave-managed queued child and still carries the project research pointer", async () => {
    await seedOperatorAndResearch();
    seedWaveChild();

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedRecord(),
    );

    const prompt = dispatchedExecutionPrompt();
    expect(prompt).toContain("Follow Quarp's project instructions.");
    expect(prompt).toContain(PROJECT_RESEARCH_POINTER_PROMPT);
    expect(prompt).not.toContain("<operator-profile>");
    expect(prompt).not.toContain("The operator prefers short answers.");
    expect(prompt).not.toContain(
      `The operator keeps a map of past joint work at ${ROOT}/lore.md`,
    );
  });

  it("keeps operator blocks away from an evicted wave executor queued send and still carries the project research pointer", async () => {
    await seedOperatorAndResearch();
    useMemoryStore.setState({ waveExecutorSessionIds: [SESSION_ID] });

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedRecord(),
    );

    const prompt = dispatchedExecutionPrompt();
    expect(prompt).toContain("Follow Quarp's project instructions.");
    expect(prompt).toContain(PROJECT_RESEARCH_POINTER_PROMPT);
    expect(prompt).not.toContain("<operator-profile>");
  });
});
