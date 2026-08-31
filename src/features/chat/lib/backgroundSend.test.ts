import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedSessionNotReadyError } from "./queuedMessageReadiness";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { MEMORY_PROTOCOL_PROMPT } from "@/features/memory/lib/memoryFence";
import { MEMORY_RECALL_PROMPT } from "@/features/memory/lib/memoryRecall";
import type {
  ArchivedMemoryEntry,
  MemoryEntry,
} from "@/features/memory/lib/memoryEntry";
import { PLANNER_PROTOCOL_PROMPT } from "@/features/planner/lib/plannerFence";

import { sendPromptInBackground } from "./backgroundSend";

const mocks = vi.hoisted(() => ({
  dispatchPrompt: vi.fn(),
  getSession: vi.fn(),
  isWaveManagedSession: vi.fn(),
  memoryEntries: [] as unknown[],
  memoryArchived: [] as unknown[],
}));

vi.mock("@/features/chat/lib/sendCore", () => ({
  dispatchPrompt: (...args: unknown[]) => mocks.dispatchPrompt(...args),
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: {
    getState: () => ({ getSession: mocks.getSession }),
  },
}));

vi.mock("@/features/conductor/waveManagedSession", () => ({
  isWaveManagedSession: (...args: unknown[]) =>
    mocks.isWaveManagedSession(...args),
}));

vi.mock("@/features/memory/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: () => ({
      entries: mocks.memoryEntries,
      archived: mocks.memoryArchived,
    }),
  },
}));

function memoryEntry(
  overrides: Partial<MemoryEntry> & { id: string; text: string },
): MemoryEntry {
  return {
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

function dispatchedSystemPrompt(): string {
  const [, , options] = mocks.dispatchPrompt.mock.calls[0] as [
    string,
    string,
    { systemPrompt?: string },
  ];
  return options.systemPrompt ?? "";
}

describe("sendPromptInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatchPrompt.mockResolvedValue(undefined);
    mocks.getSession.mockReturnValue(undefined);
    mocks.isWaveManagedSession.mockReturnValue(false);
    mocks.memoryEntries = [];
    mocks.memoryArchived = [];
    useConductorGraphStore.setState({ nodesById: {} });
  });

  it("prioritizes the captured execution prompt over current persona context", async () => {
    await sendPromptInBackground(
      "session-1",
      "queued turn",
      "goose",
      {
        id: "current-persona",
        displayName: "Current Persona",
        systemPrompt: "current persona prompt",
      },
      {
        executionSystemPrompt: "captured persona and workspace prompt",
        systemPrompt: "current workspace prompt",
      },
    );

    expect(mocks.dispatchPrompt).toHaveBeenCalledWith(
      "session-1",
      "queued turn",
      expect.objectContaining({
        systemPrompt: "captured persona and workspace prompt",
      }),
    );
  });

  it("carries the operator's memory and the protocols into the composed fallback", async () => {
    mocks.getSession.mockReturnValue({ projectId: "p-1" });
    mocks.memoryEntries = [
      memoryEntry({ id: "g", text: "A global fact" }),
      memoryEntry({
        id: "p",
        text: "A fact about this project",
        scope: "project",
        projectId: "p-1",
      }),
      memoryEntry({
        id: "other",
        text: "Another project's secret",
        scope: "project",
        projectId: "p-2",
      }),
    ];

    await sendPromptInBackground("session-1", "prompt", "goose", undefined, {
      systemPrompt: "workspace prompt",
    });

    const systemPrompt = dispatchedSystemPrompt();
    expect(systemPrompt).toContain("A global fact");
    expect(systemPrompt).toContain("A fact about this project");
    // Memory scoped to the *target* session's project: a fact from an
    // unrelated project must not ride along.
    expect(systemPrompt).not.toContain("Another project's secret");
    expect(systemPrompt).toContain(MEMORY_PROTOCOL_PROMPT);
    expect(systemPrompt).toContain(PLANNER_PROTOCOL_PROMPT);
    // Caller-provided context still leads.
    expect(systemPrompt.startsWith("workspace prompt")).toBe(true);
  });

  it("ships the memory protocol even when nothing is remembered yet", async () => {
    await sendPromptInBackground("session-1", "prompt", "goose");

    expect(dispatchedSystemPrompt()).toContain(MEMORY_PROTOCOL_PROMPT);
  });

  it("adds the generated spawn-policy line for a persona session", async () => {
    await sendPromptInBackground("session-1", "prompt", "goose", {
      id: "p-1",
      displayName: "Scout",
      systemPrompt: "persona prompt",
    });

    // The sentence the agent files used to hardcode now comes from the ACL.
    expect(dispatchedSystemPrompt()).toContain("do not spawn chats yourself");
  });

  it("adds the spawn prohibition for a personaless graph worker", async () => {
    useConductorGraphStore.setState({
      nodesById: {
        "session-1": {
          sessionId: "session-1",
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
    try {
      await sendPromptInBackground("session-1", "prompt", "goose");
      expect(dispatchedSystemPrompt()).toContain("do not spawn chats yourself");
    } finally {
      useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    }
  });

  it("gives a plain personaless chat no spawn-policy line", async () => {
    await sendPromptInBackground("session-1", "prompt", "goose", undefined, {
      systemPrompt: "workspace prompt",
    });

    expect(dispatchedSystemPrompt()).not.toContain("spawn");
  });

  it("gives a read-only graph node the facts without the memory protocol", async () => {
    mocks.getSession.mockReturnValue({ projectId: "p-1" });
    mocks.memoryEntries = [memoryEntry({ id: "g", text: "A global fact" })];
    useConductorGraphStore.setState({
      nodesById: {
        "session-1": {
          sessionId: "session-1",
          projectId: "p-1",
          role: "worker",
          managedBy: "agent-cli",
          parentSessionId: null,
          rootConductorId: null,
          runId: null,
          harnessId: "goose",
          displayName: "Scout",
          status: "running",
        },
      },
    });

    await sendPromptInBackground("session-1", "prompt", "goose");

    const systemPrompt = dispatchedSystemPrompt();
    // Reading stays broad; only the how-to-write half is withheld.
    expect(systemPrompt).toContain("A global fact");
    expect(systemPrompt).not.toContain(MEMORY_PROTOCOL_PROMPT);
    // Recall is a read, and reading is exactly what this session still does.
    expect(systemPrompt).toContain(MEMORY_RECALL_PROMPT);
    expect(systemPrompt).toContain(PLANNER_PROTOCOL_PROMPT);
  });

  it("tells the session what its block is missing, this project only", async () => {
    mocks.getSession.mockReturnValue({ projectId: "p-1" });
    mocks.memoryEntries = [memoryEntry({ id: "g", text: "A global fact" })];
    mocks.memoryArchived = [
      {
        ...memoryEntry({ id: "a-1", text: "Displaced here" }),
        scope: "project",
        projectId: "p-1",
        archivedAt: 0,
        archiveReason: "capacity",
      } satisfies ArchivedMemoryEntry,
      {
        ...memoryEntry({ id: "a-2", text: "Displaced elsewhere" }),
        scope: "project",
        projectId: "p-2",
        archivedAt: 0,
        archiveReason: "capacity",
      } satisfies ArchivedMemoryEntry,
    ];

    await sendPromptInBackground("session-1", "prompt", "goose");

    // One archived line is reachable; the other project's is not counted.
    expect(dispatchedSystemPrompt()).toContain(
      "…and 1 older memories are stored beyond this block (1 archived).",
    );
  });

  it("keeps memory and the protocols away from a wave-managed session", async () => {
    mocks.isWaveManagedSession.mockReturnValue(true);
    mocks.memoryEntries = [memoryEntry({ id: "g", text: "A global fact" })];

    await sendPromptInBackground("session-1", "prompt", "goose", undefined, {
      systemPrompt: "workspace prompt",
    });

    expect(mocks.isWaveManagedSession).toHaveBeenCalledWith("session-1");
    const systemPrompt = dispatchedSystemPrompt();
    expect(systemPrompt).toBe("workspace prompt");
    expect(systemPrompt).not.toContain(MEMORY_PROTOCOL_PROMPT);
  });

  it.each([
    new QueuedSessionNotReadyError(),
    new QueuedMessageOwnershipLostError(),
  ])("rethrows expected pre-commit rejection without a failure log", async (error) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.dispatchPrompt.mockRejectedValueOnce(error);

    await expect(
      sendPromptInBackground("session-1", "queued turn", "goose"),
    ).rejects.toBe(error);

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs true background send failures", async () => {
    const error = new Error("transport failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.dispatchPrompt.mockRejectedValueOnce(error);

    await expect(
      sendPromptInBackground("session-1", "queued turn", "goose"),
    ).rejects.toBe(error);

    expect(consoleError).toHaveBeenCalledWith(
      "[background-send] prompt failed for session session-1",
      error,
    );
  });
});
