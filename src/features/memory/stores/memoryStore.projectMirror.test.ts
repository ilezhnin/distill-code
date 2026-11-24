/**
 * The project-folder mirror against the flow it was built for (P31): a
 * project whose folder already carries memories вЂ” copied from a colleague,
 * from another machine вЂ” joining an app that is already running.
 *
 * The folder is a real store here: an in-memory map standing in for
 * `<project>/.distill/memory.json`, so a write that replaces the file is
 * visible as the file's contents and not only as a mock call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import type { ArchivedMemoryEntry, MemoryEntry } from "../lib/memoryEntry";
import { PROJECT_MEMORY_DOCUMENT } from "../lib/projectMemoryDocuments";
import {
  flushMemoryWrites,
  hydrateMemoryStore,
  resetProjectMemoryMirrorForTests,
  useMemoryStore,
} from "./memoryStore";

const folders = vi.hoisted(() => ({
  files: new Map<string, string>(),
  unreadable: new Set<string>(),
  /** A read that waits until the test releases it. */
  gates: new Map<string, Promise<void>>(),
  reads: [] as string[],
}));

vi.mock("@/shared/api/projectStore", () => ({
  readProjectDocument: async (root: string, path: string) => {
    folders.reads.push(root);
    await folders.gates.get(root);
    if (folders.unreadable.has(root)) throw new Error("drive not mounted");
    return folders.files.get(`${root}/${path}`) ?? null;
  },
  writeProjectDocument: async (
    root: string,
    path: string,
    contents: string,
  ) => {
    if (folders.unreadable.has(root)) throw new Error("drive not mounted");
    folders.files.set(`${root}/${path}`, contents);
  },
  listProjectDocuments: async (root: string) =>
    [...folders.files.keys()]
      .filter((key) => key.startsWith(`${root}/`))
      .map((key) => key.slice(root.length + 1)),
}));

const NOW = new Date(2026, 7, 26, 10, 30).getTime();

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    path: "/projects/p1",
    name: "Sample Project",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: ["/work/sample-project"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...over,
  };
}

function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: `Fact ${over.id}`,
    scope: "project",
    projectId: "from-another-machine",
    createdAt: 1,
    ...over,
  };
}

function archived(
  over: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(over),
    archivedAt: 2,
    archiveReason: "forgotten",
    ...over,
  };
}

function putFile(
  root: string,
  entries: MemoryEntry[],
  archivedEntries: ArchivedMemoryEntry[] = [],
): void {
  folders.files.set(
    `${root}/${PROJECT_MEMORY_DOCUMENT}`,
    JSON.stringify({
      version: 2,
      projectId: "from-another-machine",
      entries,
      archived: archivedEntries,
    }),
  );
}

function readFile(root: string): {
  entries: MemoryEntry[];
  archived: ArchivedMemoryEntry[];
} | null {
  const raw = folders.files.get(`${root}/${PROJECT_MEMORY_DOCUMENT}`);
  return raw ? JSON.parse(raw) : null;
}

function ids(list: readonly { id: string }[]): string[] {
  return list.map((item) => item.id);
}

describe("the project memory mirror and a project that joins late", () => {
  beforeEach(() => {
    window.localStorage.clear();
    folders.files.clear();
    folders.unreadable.clear();
    folders.gates.clear();
    folders.reads.length = 0;
    resetProjectMemoryMirrorForTests();
    useProjectStore.setState({ projects: [] });
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: false,
    });
  });

  it("keeps a colleague's memories when their project is added after startup", async () => {
    // Fresh install: the project list is empty when memory is read, and the
    // project pointing at the copied repository can only be created later.
    putFile(
      "/work/sample-project",
      [entry({ id: "c1" }), entry({ id: "c2" })],
      [archived({ id: "c-old" })],
    );
    await hydrateMemoryStore();
    expect(useMemoryStore.getState().entries).toEqual([]);

    useProjectStore.setState({ projects: [project()] });
    // Any commit at all used to flush the mirror over the folder's file.
    useMemoryStore
      .getState()
      .remember({ text: "The operator pushes", scope: "global" }, NOW);
    await flushMemoryWrites();

    const file = readFile("/work/sample-project");
    expect(ids(file?.entries ?? [])).toEqual(["c1", "c2"]);
    expect(ids(file?.archived ?? [])).toEqual(["c-old"]);
    const state = useMemoryStore.getState();
    // And they joined the store, filed under the project the folder is.
    expect(state.entries.map((item) => [item.id, item.projectId])).toEqual([
      [expect.any(String), null],
      ["c1", "p1"],
      ["c2", "p1"],
    ]);
    expect(ids(state.archived)).toEqual(["c-old"]);
  });

  it("does not write a folder it could not read", async () => {
    // A drive that is not mounted at startup and not mounted now: whatever
    // its file holds has not been merged, so it is not this run's to replace.
    putFile("/work/sample-project", [entry({ id: "c1" })]);
    folders.unreadable.add("/work/sample-project");
    useProjectStore.setState({ projects: [project()] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await hydrateMemoryStore();

    useMemoryStore
      .getState()
      .remember({ text: "The operator pushes", scope: "global" }, NOW);
    await flushMemoryWrites();

    folders.unreadable.clear();
    expect(ids(readFile("/work/sample-project")?.entries ?? [])).toEqual([
      "c1",
    ]);
  });

  it("merges a folder that comes back after startup into the store and the file", async () => {
    putFile("/work/sample-project", [entry({ id: "c1" })]);
    folders.unreadable.add("/work/sample-project");
    useProjectStore.setState({ projects: [project()] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await hydrateMemoryStore();
    folders.unreadable.clear();

    useMemoryStore
      .getState()
      .remember({ text: "Uses pnpm", scope: "project", projectId: "p1" }, NOW);
    await flushMemoryWrites();

    expect(ids(useMemoryStore.getState().entries)).toContain("c1");
    const file = readFile("/work/sample-project");
    expect(file?.entries.map((item) => item.text).sort()).toEqual([
      "Fact c1",
      "Uses pnpm",
    ]);
  });

  it("does not bring back a line the operator deleted in an earlier run", async () => {
    // The tombstones used to live only in memory, so a delete made while the
    // folder was offline was re-adopted at the first mirror after it came back
    // вЂ” undoing an explicit operator delete, which LAWS/MEMORY.md Sovereignty
    // puts above every copy on disk.
    putFile("/work/sample-project", [entry({ id: "c1" }), entry({ id: "c2" })]);
    useProjectStore.setState({ projects: [project()] });
    await hydrateMemoryStore();

    folders.unreadable.add("/work/sample-project");
    useMemoryStore.getState().forget("c1");
    await flushMemoryWrites();

    // A restart: nothing survives but the global document. The share is back.
    folders.unreadable.clear();
    resetProjectMemoryMirrorForTests();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      waveExecutorSessionIds: [],
      forgottenIds: [],
      hydrated: false,
    });
    await hydrateMemoryStore();

    expect(ids(useMemoryStore.getState().entries)).toEqual(["c2"]);
    // вЂ¦and the next mirror takes it out of the file as well.
    useMemoryStore
      .getState()
      .remember({ text: "The operator pushes", scope: "global" }, NOW);
    await flushMemoryWrites();
    expect(ids(readFile("/work/sample-project")?.entries ?? [])).toEqual([
      "c2",
    ]);
  });

  it("reads the new folder when a project is pointed somewhere else", async () => {
    putFile("/work/elsewhere", [entry({ id: "moved" })]);
    useProjectStore.setState({ projects: [project()] });
    await hydrateMemoryStore();
    expect(useMemoryStore.getState().entries).toEqual([]);

    useProjectStore.setState({
      projects: [project({ workingDirs: ["/work/elsewhere"] })],
    });
    await flushMemoryWrites();

    expect(ids(useMemoryStore.getState().entries)).toEqual(["moved"]);
  });

  it("reads a project that joins while the folders are still being read", async () => {
    // The window between the list being captured and hydration landing: a
    // project added then is in neither the hydration read nor, before this,
    // any later one.
    putFile("/work/slow", [entry({ id: "s1" })]);
    putFile("/work/sample-project", [entry({ id: "c1" })]);
    let release: () => void = () => {};
    folders.gates.set(
      "/work/slow",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const slow = project({ id: "p-slow", workingDirs: ["/work/slow"] });
    useProjectStore.setState({ projects: [slow] });

    const hydration = hydrateMemoryStore();
    await vi.waitFor(() => expect(folders.reads).toContain("/work/slow"));
    useProjectStore.setState({ projects: [slow, project()] });
    release();
    await hydration;
    await flushMemoryWrites();

    expect(ids(useMemoryStore.getState().entries).sort()).toEqual(["c1", "s1"]);
  });

  it("lets a planted folder crowd only its own project, and keeps what it did not take in the file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await hydrateMemoryStore();
    // The operator's own list: global lines, another project's, and a few
    // of this project's, all written long ago.
    const own: MemoryEntry[] = [
      ...Array.from({ length: 200 }, (_, index) =>
        entry({ id: `g${index}`, scope: "global", projectId: null }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        entry({ id: `o${index}`, projectId: "p2" }),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        entry({ id: `mine${index}`, projectId: "p1" }),
      ),
    ];
    useMemoryStore.setState({ entries: own });
    // Three hundred lines dated far in the future, none of them marked.
    const planted = Array.from({ length: 300 }, (_, index) =>
      entry({ id: `x${index}`, createdAt: 9e15, reinforcedAt: 9e15 }),
    );
    putFile("/work/sample-project", planted);

    useProjectStore.setState({ projects: [project()] });
    await flushMemoryWrites();

    const state = useMemoryStore.getState();
    const live = new Set(ids(state.entries));
    // Every global and every other project's line is still live.
    for (const line of own.slice(0, 230)) expect(live.has(line.id)).toBe(true);
    // Only this project's own lines made room, into the archive.
    expect(
      state.archived
        .filter((line) => line.id.startsWith("mine"))
        .map((line) => line.archiveReason),
    ).toEqual(Array(20).fill("capacity"));
    // Two hundred taken in, live or archived, each marked and dated now.
    const taken = [...state.entries, ...state.archived].filter((line) =>
      line.id.startsWith("x"),
    );
    expect(taken).toHaveLength(200);
    for (const line of taken) {
      expect(line.fromProjectFolder).toBe(true);
      expect(line.createdAt).toBeLessThanOrEqual(Date.now());
    }
    expect(state.entries).toHaveLength(300);

    // The next mirror writes the file back with the hundred it did not take.
    useMemoryStore
      .getState()
      .remember({ text: "The operator pushes", scope: "global" }, NOW);
    await flushMemoryWrites();
    const file = readFile("/work/sample-project");
    const inFile = new Set([
      ...ids(file?.entries ?? []),
      ...ids(file?.archived ?? []),
    ]);
    for (const line of planted) expect(inFile.has(line.id)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("100 line(s) of project p1's folder"),
    );
    // And the operator's new global line took a planted line's place, not
    // one of their own.
    expect(
      ids(useMemoryStore.getState().entries).filter((id) => id.startsWith("g")),
    ).toHaveLength(200);
    warn.mockRestore();
  });

  it("shows a restored folder line as the operator's own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    putFile("/work/sample-project", [entry({ id: "c1" })]);
    useProjectStore.setState({ projects: [project()] });
    await hydrateMemoryStore();
    expect(useMemoryStore.getState().entries[0].fromProjectFolder).toBe(true);

    const [line] = useMemoryStore.getState().entries;
    useMemoryStore.setState({
      entries: [],
      archived: [{ ...line, archivedAt: NOW, archiveReason: "capacity" }],
    });
    expect(useMemoryStore.getState().restoreArchived("c1", NOW)).toBeNull();
    expect(useMemoryStore.getState().entries[0].fromProjectFolder).toBe(
      undefined,
    );
  });
});
