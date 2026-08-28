import { describe, expect, it } from "vitest";

import type { ProjectInfo } from "@/features/projects/api/projects";

import type { MemoryEntry } from "./memoryEntry";
import {
  mergeProjectMemories,
  projectMemoryRoot,
} from "./projectMemoryDocuments";

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    path: "/projects/p1",
    name: "Quarp",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: ["/work/quarp"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...over,
  };
}

function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: over.id,
    scope: "project",
    projectId: "p1",
    createdAt: 0,
    ...over,
  };
}

describe("projectMemoryRoot", () => {
  it("takes the folder the operator thinks of as the project", () => {
    expect(projectMemoryRoot(project())).toBe("/work/quarp");
  });

  it("has nowhere to write for a project with no folder", () => {
    expect(projectMemoryRoot(project({ workingDirs: [] }))).toBeNull();
    expect(projectMemoryRoot(project({ workingDirs: ["   "] }))).toBeNull();
  });
});

describe("mergeProjectMemories", () => {
  it("adds what only the folder knows — the project that arrived from elsewhere", () => {
    const merged = mergeProjectMemories(
      [entry({ id: "a" })],
      [entry({ id: "a" }), entry({ id: "b" })],
    );
    expect(merged.map((memory) => memory.id)).toEqual(["a", "b"]);
  });

  it("never lets a copy on disk revert what is already in memory", () => {
    // Hydration runs after the global document has been read, and an entry
    // the operator edited this session must win over the folder's copy.
    const merged = mergeProjectMemories(
      [entry({ id: "a", text: "edited just now" })],
      [entry({ id: "a", text: "the copy on disk" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("edited just now");
  });

  it("returns the base unchanged when the folders add nothing", () => {
    const base = [entry({ id: "a" })];
    expect(mergeProjectMemories(base, [])).toEqual(base);
  });
});
