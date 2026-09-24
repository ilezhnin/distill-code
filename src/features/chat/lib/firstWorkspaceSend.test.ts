import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import type {
  ProjectInfo,
  ProjectWorkspace,
} from "@/features/projects/api/projects";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  acceptFirstSend,
  chooseDeferredWorkspaceSetup,
  createDeferredWorkspaces,
  provisionPreSendProjectWorkspaces,
  releaseDeferredWorkspaceSend,
  releaseWorkspaceSendAfterUserEdit,
} from "./firstWorkspaceSend";

vi.mock("@/features/projects/lib/projectChatWorkspaces", async (original) => {
  const actual =
    await original<
      typeof import("@/features/projects/lib/projectChatWorkspaces")
    >();
  return {
    ...actual,
    planProjectChatWorkspaces: vi.fn(),
    rollbackProjectChatWorkspacePlan: vi.fn(),
  };
});
vi.mock("./sessionTargetCoordinator", () => ({
  transitionSessionTarget: vi.fn(),
}));
import {
  planProjectChatWorkspaces,
  rollbackProjectChatWorkspacePlan,
} from "@/features/projects/lib/projectChatWorkspaces";
import { transitionSessionTarget } from "./sessionTargetCoordinator";

const workspace: ProjectWorkspace = {
  id: "app",
  path: "/repo/app",
  kind: "subdirectory",
  source: "selected",
  branch: "main",
  repositoryPath: "/repo",
  worktreePath: "/repo",
  usedByAgent: false,
  startupMode: "worktree",
};
const project = {
  id: "project",
  name: "Project",
  description: "",
  prompt: "",
  icon: "folder",
  color: "blue",
  order: 0,
  archivedAt: null,
  path: "/repo",
  workingDirs: ["/repo/app"],
  useWorktrees: true,
  projectWorkspaces: [workspace],
} as ProjectInfo;
const selected: WorkspaceAttachment = {
  ...workspace,
  id: "path:/repo/app",
  source: "selected",
};

function session(attachments: WorkspaceAttachment[] = []) {
  return {
    id: "s1",
    title: "Chat",
    projectId: project.id,
    executionTarget: { harnessId: "goose" },
    workingDir: "/repo/app",
    workspaceAttachments: attachments,
    createdAt: "now",
    updatedAt: "now",
    messageCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setMultiWorkspaceEnabled(true);
  vi.mocked(rollbackProjectChatWorkspacePlan).mockResolvedValue(undefined);
  useChatStore.setState({ messagesBySession: {}, queuedMessageBySession: {} });
  useChatSessionStore.setState({ sessions: [session()] });
  useProjectStore.setState({ projects: [project] });
});

describe("first workspace send", () => {
  it("provisions a named worktree before any message is queued", async () => {
    const created = {
      ...selected,
      id: "created",
      path: "/repo/worktrees/feature/app",
      source: "created" as const,
      worktreePath: "/repo/worktrees/feature",
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: created.path,
      workspaceAttachments: [created],
    });
    vi.mocked(transitionSessionTarget).mockImplementationOnce(async () => {
      expect(useChatSessionStore.getState().getSession("s1")).toMatchObject({
        workingDir: "/repo/app",
        workspaceAttachments: [],
      });
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });

    await provisionPreSendProjectWorkspaces("s1", project, "feature");

    expect(planProjectChatWorkspaces).toHaveBeenCalledWith(project, "feature");
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
    expect(useChatSessionStore.getState().getSession("s1")).toMatchObject({
      workingDir: created.path,
      workspaceAttachments: [created],
      activeWorkspaceId: created.id,
    });
    expect(transitionSessionTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", workingDir: created.path }),
    );
  });

  it("restores the backend target before rolling back a stale completed setup", async () => {
    const created = {
      ...selected,
      id: "created",
      path: "/repo/worktrees/feature/app",
      source: "created" as const,
      worktreePath: "/repo/worktrees/feature",
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: created.path,
      workspaceAttachments: [created],
    });
    let transitionCount = 0;
    vi.mocked(transitionSessionTarget).mockImplementation(async () => {
      transitionCount += 1;
      if (transitionCount === 1) {
        useProjectStore.setState({ projects: [] });
      }
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });

    await expect(
      provisionPreSendProjectWorkspaces("s1", project, "feature"),
    ).rejects.toThrow("The project workspace changed during setup. Try again.");

    expect(transitionSessionTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "s1", workingDir: "/repo/app" }),
    );
    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledOnce();
  });

  it("queues before the choice and preserves the exact payload", () => {
    const onNeedsName = vi.fn();
    expect(
      acceptFirstSend(
        "s1",
        { persona: { kind: "inherit" }, text: "hello" },
        { onNeedsName },
      ),
    ).toEqual({
      accepted: true,
      deferred: true,
      needsName: false,
    });
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    expect(record).toMatchObject({
      kind: "deferred",
      payload: { text: "hello" },
      state: { status: "choice" },
    });
    expect(onNeedsName).not.toHaveBeenCalled();
  });

  it("uses Skip to prepare the existing checkout and releases the same record", async () => {
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const before = useChatStore.getState().queuedMessageBySession.s1?.[0];

    expect(chooseDeferredWorkspaceSetup("s1", false)).toBe(true);

    await vi.waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession.s1?.[0],
      ).toMatchObject({
        kind: "transport-ready",
        recordId: before?.recordId,
        payload: { text: "hello" },
      });
    });
    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
  });

  it("rejects a second send while the deferred first-send slot is occupied", () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "first" },
      { onNeedsName: vi.fn() },
    );

    expect(
      acceptFirstSend("s1", { persona: { kind: "inherit" }, text: "second" }),
    ).toEqual({
      accepted: false,
      deferred: false,
      needsName: false,
      occupied: true,
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload.text,
    ).toBe("first");
  });

  it("fails safely when the project workspace configuration changes during naming", async () => {
    const onNeedsName = vi.fn();
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    useProjectStore.setState({
      projects: [{ ...project, projectWorkspaces: [] }],
    });

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      state: {
        status: "failed",
        error:
          "The project workspace configuration changed before setup began.",
      },
    });
  });

  it("preserves a concurrent workspace edit while rolling back prepared setup", async () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    const plan = {
      workingDir: "/created",
      workspaceAttachments: [selected],
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
    vi.mocked(transitionSessionTarget).mockImplementationOnce(async () => {
      useChatSessionStore.getState().patchSession("s1", {
        workingDir: "/user-choice",
        workspaceAttachments: [
          { ...selected, id: "user-choice", path: "/user-choice" },
        ],
      });
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(transitionSessionTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workingDir: "/user-choice" }),
    );
    expect(useChatSessionStore.getState().getSession("s1")).toMatchObject({
      workingDir: "/user-choice",
      workspaceAttachments: [expect.objectContaining({ id: "user-choice" })],
    });
    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
  });

  it("times out stalled draft promotion and rolls back workspace setup", async () => {
    vi.useFakeTimers();
    try {
      const plan = {
        workingDir: "/repo/worktrees/feature/app",
        workspaceAttachments: [selected],
      };
      vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
      useChatSessionStore.setState({
        sessions: [
          {
            ...session(),
            creationState: "pending",
            clientSessionId: "s1",
          },
        ],
      });

      const provisioning = provisionPreSendProjectWorkspaces(
        "s1",
        project,
        "feature",
      );
      const rejection = expect(provisioning).rejects.toThrow(
        "Chat creation failed during workspace setup.",
      );
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back provisioned workspaces and marks the queue failed when draft creation fails", async () => {
    const plan = {
      workingDir: "/created",
      workspaceAttachments: [selected],
      rollback: { createdWorktrees: [], createdBranches: [] },
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
    useChatSessionStore.setState({
      sessions: [
        {
          ...session(),
          creationState: "pending",
          clientSessionId: "s1",
        },
      ],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    const creating = createDeferredWorkspaces("s1", record.recordId, "feature");
    await vi.waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("s1")?.creationState,
      ).toBe("pending");
    });
    useChatSessionStore.getState().patchSession("s1", {
      creationState: "failed",
    });
    await creating;

    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      recordId: record.recordId,
      state: {
        status: "failed",
        error: "Chat creation failed before workspace setup completed.",
      },
    });
  });

  it("keeps a creating deferred message paused when setup finishes during editing", async () => {
    let finishApply:
      | ((value: {
          status: "committed";
          applied: true;
          target: { harnessId: "goose" };
        }) => void)
      | undefined;
    vi.mocked(transitionSessionTarget).mockReturnValueOnce(
      new Promise((resolve) => {
        finishApply = resolve;
      }),
    );
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    const creating = createDeferredWorkspaces("s1", record.recordId, null);
    await vi.waitFor(() => expect(transitionSessionTarget).toHaveBeenCalled());
    expect(
      useChatStore
        .getState()
        .setQueuedMessageEditing("s1", record.recordId, true),
    ).toBe(true);
    finishApply?.({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    await creating;

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId: record.recordId,
      payload: { text: "hello" },
      editing: true,
    });

    expect(
      useChatStore.getState().updateQueuedMessage("s1", record.recordId, {
        persona: { kind: "inherit" },
        text: "edited",
      }),
    ).toBe(true);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId: record.recordId,
      payload: { text: "edited" },
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).not.toHaveProperty("editing");
  });

  it("releases failure only by Send anyway or an explicit matching user edit", () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    useChatStore.getState().updateDeferredMessage("s1", record.recordId, {
      ...(record.state as object),
      status: "failed",
    });
    expect(releaseWorkspaceSendAfterUserEdit("s1")).toBe(false);
    useChatSessionStore
      .getState()
      .patchSession("s1", { workspaceAttachments: [selected] });
    expect(releaseWorkspaceSendAfterUserEdit("s1")).toBe(false);
    expect(useChatStore.getState().queuedMessageBySession.s1?.[0]?.kind).toBe(
      "deferred",
    );

    useChatStore.setState({ queuedMessageBySession: {} });
    useChatSessionStore
      .getState()
      .patchSession("s1", { workspaceAttachments: [] });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "again" },
      { onNeedsName: vi.fn() },
    );
    const again = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (again?.kind !== "deferred") throw new Error("missing second record");
    expect(releaseDeferredWorkspaceSend("s1", again.recordId, true)).toBe(true);
  });
});
