import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectArtifactMetadata } from "../artifact/types";
import type { ProjectInfo } from "./projects";

const mocks = vi.hoisted(() => ({
  sourcesList: vi.fn(),
  sourcesCreate: vi.fn(),
  sourcesUpdate: vi.fn(),
  sourcesDelete: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

function source(properties: Record<string, unknown>) {
  return {
    type: "project",
    name: "launch",
    description: "",
    content: "Ship it",
    path: "/tmp/projects/launch.md",
    global: true,
    properties,
  };
}

function artifactMetadata(
  overrides: Partial<ProjectArtifactMetadata> = {},
): ProjectArtifactMetadata {
  return {
    seed: 9876,
    color: "olive",
    mood: "serene",
    moodIntensity: 0.5,
    contentMode: "cubeStatic",
    ...overrides,
  };
}

function projectInfo(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "launch",
    path: "/tmp/projects/launch.md",
    name: "Launch",
    description: "",
    prompt: "Ship it",
    icon: "tabler:folder-code",
    color: "olive",
    projectWorkspaces: [],
    workingDirs: ["/tmp/launch"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    artifact: artifactMetadata(),
    ...overrides,
  };
}

describe("projects API artifact metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sourcesList.mockResolvedValue({ sources: [] });
    mocks.getClient.mockResolvedValue({
      host: {
        sourcesList: mocks.sourcesList,
        sourcesCreate: mocks.sourcesCreate,
        sourcesUpdate: mocks.sourcesUpdate,
        sourcesDelete: mocks.sourcesDelete,
      },
    });
  });

  it("persists structured project workspaces while deriving working dirs", async () => {
    mocks.sourcesList.mockResolvedValue({ sources: [] });
    mocks.sourcesCreate.mockImplementation(async (request) => ({
      source: source(request.properties),
    }));

    const { createProject, projectWorkspaceFromDirectory } = await import(
      "./projects"
    );
    const workspace = projectWorkspaceFromDirectory(
      "/tmp/launch/packages/app",
      "worktree",
    );

    const project = await createProject(
      "Launch",
      "",
      "Ship it",
      "tabler:folder-code",
      "olive",
      [],
      false,
      workspace ? [workspace] : [],
    );

    const createRequest = mocks.sourcesCreate.mock.calls[0]?.[0];
    expect(createRequest.properties.workingDirs).toEqual([
      "/tmp/launch/packages/app",
    ]);
    expect(createRequest.properties.useWorktrees).toBeUndefined();
    expect(createRequest.properties.projectWorkspaces).toEqual([
      expect.objectContaining({
        path: "/tmp/launch/packages/app",
        startupMode: "auto-worktree",
      }),
    ]);
    expect(project.workingDirs).toEqual(["/tmp/launch/packages/app"]);
    expect(project.projectWorkspaces).toEqual([
      expect.objectContaining({
        path: "/tmp/launch/packages/app",
        startupMode: "auto-worktree",
      }),
    ]);
  });

  it("migrates legacy branch startup to manually managed worktrees", async () => {
    const { normalizeProjectWorkspaces } = await import("./projects");

    expect(
      normalizeProjectWorkspaces([
        {
          id: "legacy-branch",
          path: "/tmp/legacy",
          kind: "repository",
          source: "selected",
          branch: "main",
          usedByAgent: false,
          startupMode: "branch",
        },
      ]),
    ).toEqual([expect.objectContaining({ startupMode: "ask-worktree" })]);
  });

  it("keeps fields another writer changed while the caller held its snapshot", async () => {
    const chatGroups = {
      groups: [
        {
          id: "launch:chat-group:readiness",
          name: "Readiness",
          chatIds: ["session-1"],
        },
      ],
    };
    // What is on disk now: another writer added a chat group and bumped order.
    mocks.sourcesList.mockResolvedValue({
      sources: [
        source({
          title: "Launch",
          icon: "tabler:folder-code",
          color: "olive",
          workingDirs: ["/tmp/launch"],
          useWorktrees: false,
          order: 3,
          chatGroups,
        }),
      ],
    });
    mocks.sourcesUpdate.mockImplementation(async (request) => ({
      source: source(request.properties),
    }));

    const { updateProject } = await import("./projects");
    // The dialog's snapshot predates both changes.
    const project = await updateProject(
      projectInfo({ order: 0, chatGroups: null }),
      { name: "Launch v2" },
    );

    const updateRequest = mocks.sourcesUpdate.mock.calls[0]?.[0];
    expect(updateRequest.properties.title).toBe("Launch v2");
    expect(updateRequest.properties.chatGroups).toEqual(chatGroups);
    expect(updateRequest.properties.order).toBe(3);
    expect(project.chatGroups).toEqual(chatGroups);
  });
});

describe("normalizeProjectWorkspaces dedupe identity", () => {
  it("collapses Windows drive-equivalent working dirs to one workspace and ID", async () => {
    const { normalizeProjectWorkspaces } = await import("./projects");
    const { workspaceAttachmentIdForPath } = await import(
      "@/features/chat/lib/workspaceAttachments"
    );

    const workspaces = normalizeProjectWorkspaces(undefined, [
      "C:\\Repo",
      "c:/repo/",
    ]);

    expect(workspaces).toHaveLength(1);
    // Last-writer-wins retains the trailing-slash spelling from the input.
    expect(workspaces[0]?.path).toBe("c:/repo/");
    expect(workspaces[0]?.id).toBe(workspaceAttachmentIdForPath("C:\\Repo"));
  });

  it("keeps drive-relative working dirs distinct by drive and from ordinary relative paths", async () => {
    const { normalizeProjectWorkspaces } = await import("./projects");

    const workspaces = normalizeProjectWorkspaces(undefined, [
      "C:foo/../bar",
      "D:foo/../bar",
      "bar",
      "C:../bar",
      "C:../../bar",
      "c:foo/../bar",
    ]);

    expect(workspaces).toHaveLength(6);
    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(6);
  });

  it("collapses drive-equivalent explicit workspaces to a single stable ID", async () => {
    const { normalizeProjectWorkspaces } = await import("./projects");
    const { workspaceAttachmentIdForPath } = await import(
      "@/features/chat/lib/workspaceAttachments"
    );

    const workspaces = normalizeProjectWorkspaces([
      {
        id: "path:C:/Repo",
        path: "C:\\Repo",
        kind: "directory",
        source: "inferred",
        branch: null,
        usedByAgent: false,
        startupMode: "none",
      },
      {
        id: workspaceAttachmentIdForPath("c:/repo/"),
        path: "c:/repo/",
        kind: "directory",
        source: "inferred",
        branch: null,
        usedByAgent: false,
        startupMode: "none",
      },
    ]);

    expect(workspaces).toHaveLength(1);
    const [only] = workspaces;
    expect(
      workspaces.filter((workspace) => workspace.id === only?.id),
    ).toHaveLength(1);
  });
});
