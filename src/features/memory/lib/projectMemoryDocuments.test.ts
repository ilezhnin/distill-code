import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "@/features/projects/api/projects";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import {
  foldProjectMemories,
  mergeProjectMemories,
  readProjectMemories,
  readProjectMemoryFolder,
} from "./projectMemoryDocuments";

const readProjectDocument = vi.hoisted(() => vi.fn());
const writeProjectDocument = vi.hoisted(() => vi.fn());
const listProjectDocuments = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/projectStore", () => ({
  readProjectDocument,
  writeProjectDocument,
  listProjectDocuments,
}));

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

function archived(
  over: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(over),
    archivedAt: 0,
    archiveReason: "capacity",
    ...over,
  };
}

/** The two parsers the store hands in, kept simple on purpose. */
const parseEntries = (raw: unknown): MemoryEntry[] =>
  ((raw as { entries?: MemoryEntry[] })?.entries ?? []) as MemoryEntry[];
const parseArchived = (raw: unknown): ArchivedMemoryEntry[] =>
  ((raw as { archived?: ArchivedMemoryEntry[] })?.archived ??
    []) as ArchivedMemoryEntry[];

describe("mergeProjectMemories", () => {
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
});

describe("readProjectMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a v1 folder file without losing its memories", async () => {
    readProjectDocument.mockResolvedValue(
      JSON.stringify({
        version: 1,
        projectId: "p1",
        entries: [entry({ id: "live" })],
      }),
    );

    const read = await readProjectMemories(
      [project()],
      parseEntries,
      parseArchived,
    );

    expect(read.entries.map((memory) => memory.id)).toEqual(["live"]);
    expect(read.archived).toEqual([]);
  });

  it("drops a folder line carrying a secret, and only that line", async () => {
    // A project folder is an entrance, not a backup: the file may come from a
    // cloned repository, a colleague's machine, or a build that had no secret
    // check at all, and everything read here goes straight into the prompt
    // block (LAWS/MEMORY.md, Writing). Refusal is per line, so one bad
    // statement does not cost the project its whole record. Shapes the rules
    // refuse; never real credentials.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readProjectDocument.mockResolvedValue(
      JSON.stringify({
        version: 2,
        projectId: "p1",
        entries: [
          entry({ id: "safe", text: "Uses pnpm" }),
          entry({ id: "leaky", text: `api_key=${"b".repeat(20)}` }),
        ],
        archived: [
          archived({ id: "safe-archived", text: "Used to use npm" }),
          archived({ id: "leaky-archived", text: `AKIA${"Q".repeat(16)}` }),
        ],
      }),
    );

    const read = await readProjectMemories(
      [project()],
      parseEntries,
      parseArchived,
    );

    expect(read.entries.map((memory) => memory.id)).toEqual(["safe"]);
    // The archive half too: "Restore" is one click from the prompt block.
    expect(read.archived.map((memory) => memory.id)).toEqual(["safe-archived"]);
    // What was refused is said by shape and never by value.
    for (const [message] of warn.mock.calls) {
      expect(message).not.toContain("AKIA");
      expect(message).not.toContain("api_key");
    }
    warn.mockRestore();
  });
});

describe("readProjectMemoryFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats a file that will not parse as unread, not as empty", async () => {
    // Overwriting it would destroy whatever a person could still recover.
    readProjectDocument.mockResolvedValue("{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      readProjectMemoryFolder(project(), parseEntries, parseArchived),
    ).resolves.toBeNull();
  });
});

describe("foldProjectMemories", () => {
  it("does not revive a line the store has archived and the folder still shows live", () => {
    // The folder lagging behind the store, not a second memory: merging the
    // lists one at a time put such a line in both.
    const folded = foldProjectMemories(
      {
        entries: [],
        archived: [archived({ id: "a", archiveReason: "forgotten" })],
      },
      { entries: [entry({ id: "a" })], archived: [] },
    );
    expect(folded.entries).toEqual([]);
    expect(folded.archived.map((memory) => memory.id)).toEqual(["a"]);
    expect(folded.added).toBe(0);
  });

  it("leaves out what the operator deleted this run", () => {
    const folded = foldProjectMemories(
      { entries: [], archived: [] },
      { entries: [entry({ id: "gone" }), entry({ id: "kept" })], archived: [] },
      new Set(["gone"]),
    );
    expect(folded.entries.map((memory) => memory.id)).toEqual(["kept"]);
  });
});
