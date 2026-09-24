import { beforeEach, describe, expect, it } from "vitest";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import { workspaceAttachmentIdForPath } from "@/features/chat/lib/workspaceAttachments";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import { getWorkspaceRepository } from "./workspaceRepository";

function attachment(
  path: string,
  overrides: Partial<WorkspaceAttachment> = {},
): WorkspaceAttachment {
  return {
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent: false,
    ...overrides,
  };
}

describe("WorkspaceRepository", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preserves matching attachment metadata in single mode when no active workspace is set", () => {
    setMultiWorkspaceEnabled(false);

    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
      workingDir: "/repo-linked",
      workspaceAttachments: [
        {
          id: workspaceAttachmentIdForPath("/repo-linked"),
          path: "/repo-linked",
          kind: "git-linked-worktree",
          source: "selected",
          branch: "feature",
          repositoryPath: "/repo-main",
          worktreePath: "/repo-linked",
          usedByAgent: false,
        },
      ],
      messageCount: 0,
    });

    expect(workspaceSet.mode).toBe("single");
    expect(workspaceSet.primary).toMatchObject({
      path: "/repo-linked",
      kind: "git-linked-worktree",
      branch: "feature",
      repositoryPath: "/repo-main",
      worktreePath: "/repo-linked",
    });
  });

  it("keeps configured project workspaces hidden rather than discarding them in single mode", () => {
    const project = {
      projectWorkspaces: [
        {
          ...attachment("/repo-main"),
          startupMode: "none" as const,
        },
        {
          ...attachment("/repo-secondary"),
          startupMode: "worktree" as const,
        },
      ],
      workingDirs: ["/repo-main", "/repo-secondary"],
      useWorktrees: false,
    };

    setMultiWorkspaceEnabled(false);
    expect(
      getWorkspaceRepository()
        .projectWorkspaces(project)
        .workspaces.map((workspace) => workspace.path),
    ).toEqual(["/repo-main"]);

    setMultiWorkspaceEnabled(true);
    expect(
      getWorkspaceRepository()
        .projectWorkspaces(project)
        .workspaces.map((workspace) => workspace.path),
    ).toEqual(["/repo-main", "/repo-secondary"]);
  });

  it("does not add worktree startup project paths to a created chat workspace plan", () => {
    setMultiWorkspaceEnabled(true);

    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
      workingDir: "/repo-worktrees/chat-123/builderbot",
      workspaceAttachments: [
        attachment("/repo-worktrees/chat-123/builderbot", {
          kind: "subdirectory",
          source: "created",
          branch: "chat-123",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
        }),
      ],
      messageCount: 0,
    });

    expect(workspaceSet.workspaces.map((workspace) => workspace.path)).toEqual([
      "/repo-worktrees/chat-123/builderbot",
    ]);
    expect(workspaceSet.primary?.path).toBe(
      "/repo-worktrees/chat-123/builderbot",
    );
  });
});
