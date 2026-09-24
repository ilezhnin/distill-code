import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../api/projects";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  reorderProjects: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../api/projects", async () => ({
  ...(await vi.importActual<typeof import("../api/projects")>(
    "../api/projects",
  )),
  listProjects: (...args: unknown[]) => mocks.listProjects(...args),
  reorderProjects: (...args: unknown[]) => mocks.reorderProjects(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
}));

const { useProjectStore } = await import("./projectStore");

function project(id: string, order: number): ProjectInfo {
  return {
    id,
    path: `/tmp/projects/${id}.md`,
    name: id,
    description: "",
    prompt: "",
    icon: "tabler:folder-code",
    color: "olive",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order,
    archivedAt: null,
  };
}

function orderedIds(call: unknown): string[] {
  return (call as [string, number][]).map(([id]) => id);
}

describe("projectStore reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reorderProjects.mockResolvedValue(undefined);
    mocks.listProjects.mockResolvedValue([]);
    useProjectStore.setState({
      projects: [project("a", 0), project("b", 1), project("c", 2)],
      loading: false,
      hasFetchedProjects: true,
      activeProjectId: null,
    });
  });

  it("writes only the latest order when two drags land together", async () => {
    const store = useProjectStore.getState();
    store.reorderProjects("a", "c", "after");
    store.reorderProjects("c", "a", "before");

    await vi.waitFor(() => {
      expect(mocks.reorderProjects).toHaveBeenCalledTimes(1);
    });
    expect(orderedIds(mocks.reorderProjects.mock.calls[0]?.[0])).toEqual(
      useProjectStore.getState().projects.map((p) => p.id),
    );
  });

  it("reports a failed reorder and reloads the stored order", async () => {
    mocks.reorderProjects.mockRejectedValueOnce(new Error("locked"));
    mocks.listProjects.mockResolvedValue([project("a", 0)]);

    useProjectStore.getState().reorderProjects("a", "b", "after");

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(mocks.listProjects).toHaveBeenCalledTimes(1);
    });
  });
});
