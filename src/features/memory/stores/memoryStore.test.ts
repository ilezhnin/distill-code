import { beforeEach, describe, expect, it } from "vitest";

import type { ArchivedMemoryEntry, MemoryEntry } from "../lib/memoryEntry";
import { MAX_ARCHIVED_ENTRIES } from "../lib/memoryEntry";
import type { MemoryFenceRequest } from "../lib/memoryFence";
import {
  capArchived,
  capWithArchive,
  flushMemoryWrites,
  MAX_MEMORY_ENTRIES,
  MEMORY_STORAGE_KEY,
  MAX_APPLIED_MEMORY_MESSAGE_IDS,
  parseArchivedMemoryEntries,
  parseMemoryEntries,
  parseRecallAnsweredMessageIds,
  useMemoryStore,
} from "./memoryStore";

const NOW = new Date(2026, 7, 26, 10, 30).getTime();

function request(overrides: Partial<MemoryFenceRequest> = {}) {
  return { remember: [], forget: [], ...overrides };
}

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

function archived(
  overrides: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(overrides),
    archivedAt: 0,
    archiveReason: "capacity",
    ...overrides,
  };
}

describe("useMemoryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Hydration is what unlocks writing; outside the desktop app the document
    // layer falls back to the same localStorage key these cases read.
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });
  });

  it("keeps a memory across a reload", async () => {
    useMemoryStore
      .getState()
      .remember({ text: "Ivan pushes", scope: "global" });
    await flushMemoryWrites();

    const stored = parseMemoryEntries(
      JSON.parse(window.localStorage.getItem(MEMORY_STORAGE_KEY) ?? "{}"),
    );
    expect(stored.map((e) => e.text)).toEqual(["Ivan pushes"]);
  });

  it("refuses a project memory with no project to belong to", () => {
    expect(
      useMemoryStore.getState().remember({ text: "Orphan", scope: "project" }),
    ).toBe("");
    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });

  it("restating a memory reinforces it instead of doubling it", () => {
    const first = useMemoryStore
      .getState()
      .remember({ text: "The branch is main", scope: "global" }, NOW);
    const second = useMemoryStore
      .getState()
      .remember({ text: "  the BRANCH is main ", scope: "global" }, NOW + 5);

    expect(second).toBe(first);
    expect(useMemoryStore.getState().entries).toHaveLength(1);
    expect(useMemoryStore.getState().entries[0].reinforcedAt).toBe(NOW + 5);
  });

  it("forgets what the operator deletes", () => {
    const id = useMemoryStore
      .getState()
      .remember({ text: "Wrong", scope: "global" });
    useMemoryStore.getState().forget(id);
    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });
});

describe("memory applyAgentRequest", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Hydration is what unlocks writing; outside the desktop app the document
    // layer falls back to the same localStorage key these cases read.
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });
  });

  it("keeps an agent's fact in the project the session belongs to", () => {
    const result = useMemoryStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s-1",
        "p-1",
        request({ remember: [{ text: "Uses pnpm", scope: "project" }] }),
        NOW,
      );

    expect(result).toEqual({ remembered: 1, forgotten: 0 });
    expect(useMemoryStore.getState().entries[0]).toMatchObject({
      text: "Uses pnpm",
      scope: "project",
      projectId: "p-1",
      createdBySessionId: "s-1",
    });
  });

  it("drops a project fact from a session that has no project", () => {
    // Filing it globally instead would be the app inventing a scope.
    const result = useMemoryStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s-1",
        null,
        request({ remember: [{ text: "Homeless", scope: "project" }] }),
        NOW,
      );

    expect(result.remembered).toBe(0);
    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });

  it("reads one message exactly once", () => {
    const req = request({ remember: [{ text: "Once", scope: "global" }] });
    useMemoryStore.getState().applyAgentRequest("m-1", "s", null, req, NOW);
    const second = useMemoryStore
      .getState()
      .applyAgentRequest("m-1", "s", null, req, NOW);

    expect(second).toEqual({ remembered: 0, forgotten: 0 });
    expect(useMemoryStore.getState().entries).toHaveLength(1);
  });

  it("applies a correction as one replacement", () => {
    useMemoryStore
      .getState()
      .remember({ text: "The branch is main", scope: "global" }, NOW);

    const result = useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s",
      "p-1",
      request({
        forget: ["the branch is main"],
        remember: [{ text: "The branch is release/2026.9", scope: "global" }],
      }),
      NOW,
    );

    expect(result).toEqual({ remembered: 1, forgotten: 1 });
    expect(useMemoryStore.getState().entries.map((e) => e.text)).toEqual([
      "The branch is release/2026.9",
    ]);
  });

  it("will not forget another project's memory", () => {
    useMemoryStore.setState({
      entries: [
        entry({ id: "x", text: "Theirs", scope: "project", projectId: "p-2" }),
      ],
      archived: [],
      appliedMessageIds: [],
    });

    const result = useMemoryStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s",
        "p-1",
        request({ forget: ["Theirs"] }),
        NOW,
      );

    expect(result.forgotten).toBe(0);
    expect(useMemoryStore.getState().entries).toHaveLength(1);
  });
});

describe("parseMemoryEntries", () => {
  it("keeps the readable rows of a half-broken list", () => {
    const parsed = parseMemoryEntries({
      entries: [
        { id: "", text: "no id" },
        { id: "ok", text: "readable", scope: "global" },
        { id: "blank", text: "   " },
        { id: "orphan", text: "scoped nowhere", scope: "project" },
        "not an object",
      ],
    });

    expect(parsed.map((e) => e.id)).toEqual(["ok"]);
  });

  it("has no opinion on junk", () => {
    expect(parseMemoryEntries(null)).toEqual([]);
    expect(parseMemoryEntries("nope")).toEqual([]);
  });
});

describe("capWithArchive", () => {
  it("hands the oldest past the bound back instead of dropping it", () => {
    const entries = Array.from({ length: MAX_MEMORY_ENTRIES + 1 }, (_, index) =>
      entry({ id: `e-${index}`, createdAt: index }),
    );
    const { kept, evicted } = capWithArchive(entries);
    expect(kept).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(kept.some((e) => e.id === "e-0")).toBe(false);
    expect(evicted.map((e) => e.id)).toEqual(["e-0"]);
  });

  it("evicts nobody below the bound", () => {
    const entries = [entry({ id: "only" })];
    expect(capWithArchive(entries)).toEqual({ kept: entries, evicted: [] });
  });
});

describe("capWithArchive recency", () => {
  it("keeps a reinforced memory over a newer one that was never restated", () => {
    // The order of eviction is unchanged by archiving; only the fate of what
    // is evicted is.
    const entries = [
      entry({ id: "reinforced", createdAt: 0, reinforcedAt: 10_000 }),
      ...Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) =>
        entry({ id: `e-${index}`, createdAt: 100 + index }),
      ),
    ];

    const { kept, evicted } = capWithArchive(entries);
    expect(kept).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(kept.some((e) => e.id === "reinforced")).toBe(true);
    expect(evicted.map((e) => e.id)).toEqual(["e-0"]);
  });
});

describe("capArchived", () => {
  it("keeps the newest displacements when the archive is full", () => {
    const list = Array.from({ length: MAX_ARCHIVED_ENTRIES + 2 }, (_, index) =>
      archived({ id: `a-${index}`, archivedAt: index }),
    );
    const capped = capArchived(list);
    expect(capped).toHaveLength(MAX_ARCHIVED_ENTRIES);
    expect(capped[0].id).toBe("a-2");
    expect(capped.at(-1)?.id).toBe(`a-${MAX_ARCHIVED_ENTRIES + 1}`);
  });

  it("leaves an archive under the bound exactly as it is", () => {
    const list = [archived({ id: "a" })];
    expect(capArchived(list)).toBe(list);
  });
});

describe("the memory archive", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });
  });

  it("archives the memory the cap pushes out instead of destroying it", () => {
    // The 301st fact must not cost the first one: displacement is allowed,
    // destruction is not (LAWS/MEMORY.md, Sovereignty).
    useMemoryStore.setState({
      entries: Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) =>
        entry({ id: `e-${index}`, text: `Fact ${index}`, createdAt: index }),
      ),
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });

    useMemoryStore
      .getState()
      .remember({ text: "One more fact", scope: "global" }, NOW);

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(state.entries.some((e) => e.id === "e-0")).toBe(false);
    expect(state.archived).toHaveLength(1);
    expect(state.archived[0]).toMatchObject({
      id: "e-0",
      text: "Fact 0",
      archiveReason: "capacity",
      archivedAt: NOW,
    });
  });

  it("keeps the text of what an agent asked to forget", () => {
    useMemoryStore
      .getState()
      .remember({ text: "The branch is main", scope: "global" }, NOW);

    useMemoryStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s",
        "p-1",
        request({ forget: ["the branch is main"] }),
        NOW + 1,
      );

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(0);
    expect(state.archived).toHaveLength(1);
    expect(state.archived[0]).toMatchObject({
      text: "The branch is main",
      archiveReason: "forgotten",
      archivedAt: NOW + 1,
    });
    expect(state.archived[0].replacedById).toBeUndefined();
  });

  it("records a correction as superseded by the line that replaced it", () => {
    useMemoryStore
      .getState()
      .remember({ text: "The branch is main", scope: "global" }, NOW);

    useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s",
      "p-1",
      request({
        forget: ["the branch is main"],
        remember: [{ text: "The branch is release/2026.9", scope: "global" }],
      }),
      NOW + 1,
    );

    const state = useMemoryStore.getState();
    expect(state.archived[0].archiveReason).toBe("superseded");
    expect(state.archived[0].replacedById).toBe(state.entries[0].id);
  });

  it("pairs a correction by position, not by reading the statements", () => {
    // `forget[1]` has no `remember[1]` behind it, so it is a retirement.
    useMemoryStore.setState({
      entries: [
        entry({ id: "old", text: "The branch is main" }),
        entry({ id: "stale", text: "Ivan is on holiday" }),
      ],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });

    useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s",
      null,
      request({
        forget: ["The branch is main", "Ivan is on holiday"],
        remember: [{ text: "The branch is release/2026.9", scope: "global" }],
      }),
      NOW,
    );

    const state = useMemoryStore.getState();
    expect(
      state.archived.map((e) => [e.id, e.archiveReason, e.replacedById]),
    ).toEqual([
      ["old", "superseded", state.entries[0].id],
      ["stale", "forgotten", undefined],
    ]);
  });

  it("does not call it a correction when the replacement was refused", () => {
    // A project fact from a session with no project is dropped, so there is
    // nothing for the retired line to point at.
    useMemoryStore.setState({
      entries: [entry({ id: "old", text: "The branch is main" })],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });

    useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s",
      null,
      request({
        forget: ["The branch is main"],
        remember: [{ text: "The branch is release/2026.9", scope: "project" }],
      }),
      NOW,
    );

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(0);
    expect(state.archived[0]).toMatchObject({ archiveReason: "forgotten" });
    expect(state.archived[0].replacedById).toBeUndefined();
  });

  it("leaves no copy behind when the operator deletes a memory", () => {
    // The archive protects the operator's record from the app, not from the
    // operator: their delete has to mean delete.
    const id = useMemoryStore
      .getState()
      .remember({ text: "My home address", scope: "global" }, NOW);
    useMemoryStore.getState().forget(id);

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(0);
    expect(state.archived).toEqual([]);
  });

  it("stores the archive alongside the live list", async () => {
    useMemoryStore
      .getState()
      .remember({ text: "The branch is main", scope: "global" }, NOW);
    useMemoryStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s",
        null,
        request({ forget: ["The branch is main"] }),
        NOW + 1,
      );
    await flushMemoryWrites();

    const stored = JSON.parse(
      window.localStorage.getItem(MEMORY_STORAGE_KEY) ?? "{}",
    );
    expect(stored.version).toBe(2);
    expect(parseArchivedMemoryEntries(stored).map((e) => e.text)).toEqual([
      "The branch is main",
    ]);
  });
});

describe("answered recall questions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: true,
    });
  });

  it("remembers an answered question across a reload", async () => {
    useMemoryStore.getState().markRecallAnswered("m-1");
    await flushMemoryWrites();

    const stored = JSON.parse(
      window.localStorage.getItem(MEMORY_STORAGE_KEY) ?? "{}",
    );
    expect(stored.version).toBe(2);
    expect(parseRecallAnsweredMessageIds(stored)).toEqual(["m-1"]);
  });

  it("records one question once", () => {
    useMemoryStore.getState().markRecallAnswered("m-1");
    useMemoryStore.getState().markRecallAnswered("m-1");
    expect(useMemoryStore.getState().recallAnsweredMessageIds).toEqual(["m-1"]);
  });

  it("keeps the newest tombstones when it runs out of room", () => {
    useMemoryStore.setState({
      recallAnsweredMessageIds: Array.from(
        { length: MAX_APPLIED_MEMORY_MESSAGE_IDS },
        (_, index) => `old-${index}`,
      ),
    });
    useMemoryStore.getState().markRecallAnswered("newest");

    const kept = useMemoryStore.getState().recallAnsweredMessageIds;
    expect(kept).toHaveLength(MAX_APPLIED_MEMORY_MESSAGE_IDS);
    expect(kept.at(-1)).toBe("newest");
    expect(kept).not.toContain("old-0");
  });

  it("does not disturb the write side's tombstones", () => {
    useMemoryStore.setState({ appliedMessageIds: ["w-1"] });
    useMemoryStore.getState().markRecallAnswered("m-1");
    expect(useMemoryStore.getState().appliedMessageIds).toEqual(["w-1"]);
  });

  it("reads a v1 document as having answered nothing", () => {
    expect(parseRecallAnsweredMessageIds({ version: 1, entries: [] })).toEqual(
      [],
    );
  });
});

describe("parseArchivedMemoryEntries", () => {
  it("reads a v1 document without losing anything it holds", () => {
    // v1 has no archive, which is the same thing as an empty one.
    const v1 = {
      version: 1,
      entries: [{ id: "a", text: "Ivan pushes", scope: "global" }],
      appliedMessageIds: ["m-1"],
    };
    expect(parseMemoryEntries(v1).map((e) => e.text)).toEqual(["Ivan pushes"]);
    expect(parseArchivedMemoryEntries(v1)).toEqual([]);
  });

  it("salvages a row whose reason it does not recognise", () => {
    const parsed = parseArchivedMemoryEntries({
      archived: [
        {
          id: "a",
          text: "Still worth keeping",
          scope: "global",
          archiveReason: "shredded",
        },
        {
          id: "b",
          text: "Retired",
          scope: "global",
          archiveReason: "forgotten",
          archivedAt: 7,
          replacedById: "c",
        },
        { id: "", text: "no id" },
      ],
    });

    expect(parsed).toEqual([
      {
        id: "a",
        text: "Still worth keeping",
        scope: "global",
        projectId: null,
        createdAt: 0,
        archivedAt: 0,
        archiveReason: "capacity",
      },
      {
        id: "b",
        text: "Retired",
        scope: "global",
        projectId: null,
        createdAt: 0,
        archivedAt: 7,
        archiveReason: "forgotten",
        replacedById: "c",
      },
    ]);
  });

  it("has no opinion on junk", () => {
    expect(parseArchivedMemoryEntries(null)).toEqual([]);
    expect(parseArchivedMemoryEntries("nope")).toEqual([]);
  });
});
