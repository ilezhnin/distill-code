import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "@/features/projects/api/projects";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import {
  foldProjectMemories,
  mergeProjectMemories,
  PROJECT_MEMORY_DOCUMENT,
  projectMemoryRoot,
  readProjectMemories,
  readProjectMemoryFolder,
  writeProjectMemories,
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

describe("writeProjectMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProjectDocuments.mockResolvedValue([]);
    writeProjectDocument.mockResolvedValue(undefined);
  });

  it("sends a project's archive along with its live memories", () => {
    // A project that moves carries what was learned about it, including what
    // was displaced: an archive left behind is a deletion by another name.
    return writeProjectMemories(
      [project()],
      [entry({ id: "live" })],
      [archived({ id: "gone", archiveReason: "forgotten", archivedAt: 5 })],
    ).then(() => {
      const [root, path, contents] = writeProjectDocument.mock.calls[0];
      expect(root).toBe("/work/quarp");
      expect(path).toBe(PROJECT_MEMORY_DOCUMENT);
      expect(JSON.parse(contents)).toEqual({
        version: 2,
        projectId: "p1",
        entries: [entry({ id: "live" })],
        archived: [
          archived({ id: "gone", archiveReason: "forgotten", archivedAt: 5 }),
        ],
      });
    });
  });

  it("writes a folder that only has an archive left", async () => {
    // Everything live was retired; the file still has to be written, or the
    // folder keeps a copy of what is no longer current.
    await writeProjectMemories(
      [project()],
      [],
      [archived({ id: "gone", archiveReason: "forgotten" })],
    );
    expect(writeProjectDocument).toHaveBeenCalledTimes(1);
  });

  it("leaves a project that has never had a memory without a file", async () => {
    await writeProjectMemories([project()], [], []);
    expect(writeProjectDocument).not.toHaveBeenCalled();
  });

  it("takes the caller's word for whether the file exists", async () => {
    // The mirror has just read the folder; asking it again is a round trip
    // for an answer it already has.
    await writeProjectMemories([project()], [], [], new Map([["p1", true]]));
    expect(listProjectDocuments).not.toHaveBeenCalled();
    expect(writeProjectDocument).toHaveBeenCalledTimes(1);

    writeProjectDocument.mockClear();
    await writeProjectMemories([project()], [], [], new Map([["p1", false]]));
    expect(listProjectDocuments).not.toHaveBeenCalled();
    expect(writeProjectDocument).not.toHaveBeenCalled();
  });
});

describe("readProjectMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("files both lists under the project the folder belongs to", async () => {
    readProjectDocument.mockResolvedValue(
      JSON.stringify({
        version: 2,
        projectId: "from-another-machine",
        entries: [entry({ id: "live", projectId: "elsewhere" })],
        archived: [archived({ id: "gone", projectId: "elsewhere" })],
      }),
    );

    const read = await readProjectMemories(
      [project()],
      parseEntries,
      parseArchived,
    );

    expect(read.entries.map((memory) => memory.projectId)).toEqual(["p1"]);
    expect(read.archived.map((memory) => memory.projectId)).toEqual(["p1"]);
    expect(read.archived[0].archiveReason).toBe("capacity");
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

  it("costs one folder, not the read, when a folder cannot be read", async () => {
    readProjectDocument.mockImplementation(async (root: string) => {
      if (root === "/work/quarp") throw new Error("drive not mounted");
      return JSON.stringify({ version: 2, entries: [entry({ id: "ok" })] });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await readProjectMemories(
      [project(), project({ id: "p2", workingDirs: ["/work/other"] })],
      parseEntries,
      parseArchived,
    );

    expect(read.entries.map((memory) => memory.id)).toEqual(["ok"]);
    // The folder that could not be read is named as such: its file may hold
    // lines nothing else does, and it is not this run's to write.
    expect(read.readProjectIds).toEqual(["p2"]);
  });
});

describe("readProjectMemoryFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells a folder with no file apart from one it could not read", async () => {
    readProjectDocument.mockResolvedValue(null);
    await expect(
      readProjectMemoryFolder(project(), parseEntries, parseArchived),
    ).resolves.toEqual({ entries: [], archived: [], hasFile: false });

    readProjectDocument.mockRejectedValue(new Error("drive not mounted"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      readProjectMemoryFolder(project(), parseEntries, parseArchived),
    ).resolves.toBeNull();
  });

  it("treats a file that will not parse as unread, not as empty", async () => {
    // Overwriting it would destroy whatever a person could still recover.
    readProjectDocument.mockResolvedValue("{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      readProjectMemoryFolder(project(), parseEntries, parseArchived),
    ).resolves.toBeNull();
  });

  it("has nothing to read for a project with no folder", async () => {
    await expect(
      readProjectMemoryFolder(
        project({ workingDirs: [] }),
        parseEntries,
        parseArchived,
      ),
    ).resolves.toEqual({ entries: [], archived: [], hasFile: false });
    expect(readProjectDocument).not.toHaveBeenCalled();
  });
});

describe("foldProjectMemories", () => {
  it("adds what only the folder knows, to whichever list it is in", () => {
    const folded = foldProjectMemories(
      { entries: [entry({ id: "a" })], archived: [archived({ id: "x" })] },
      {
        entries: [entry({ id: "a" }), entry({ id: "b" })],
        archived: [archived({ id: "x" }), archived({ id: "y" })],
      },
    );
    expect(folded.entries.map((memory) => memory.id)).toEqual(["a", "b"]);
    expect(folded.archived.map((memory) => memory.id)).toEqual(["x", "y"]);
    expect(folded.added).toBe(2);
  });

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

  it("hands the base lists back untouched when there is nothing to add", () => {
    const base = { entries: [entry({ id: "a" })], archived: [] };
    const folded = foldProjectMemories(base, { entries: [], archived: [] });
    expect(folded.entries).toBe(base.entries);
    expect(folded.archived).toBe(base.archived);
  });
});

describe("mergeProjectMemories over an archive", () => {
  it("adds what only the folder knows and keeps what this session holds", () => {
    const merged = mergeProjectMemories(
      [archived({ id: "a", text: "archived here" })],
      [
        archived({ id: "a", text: "the copy on disk" }),
        archived({ id: "b", archiveReason: "forgotten" }),
      ],
    );

    expect(merged.map((memory) => memory.text)).toEqual(["archived here", "b"]);
    expect(merged[1].archiveReason).toBe("forgotten");
  });
});
