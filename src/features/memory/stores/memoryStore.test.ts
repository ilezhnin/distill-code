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
  memoryRememberRefusal,
  parseArchivedMemoryEntries,
  parseMemoryEntries,
  parseRecallAnsweredMessageIds,
  supersededChain,
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

  it("narrowing a fact to a project writes the project's own row", () => {
    // Checklist C.3 with a statement the operator already keeps everywhere:
    // the global row is not the row they asked for, and reinforcing it
    // instead would clear the form and show nothing new.
    const text = "The release branch is release/2026.9";
    const globalId = useMemoryStore
      .getState()
      .remember({ text, scope: "global" }, NOW);
    const projectId = useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: "p-1" }, NOW + 5);

    expect(projectId).not.toBe("");
    expect(projectId).not.toBe(globalId);
    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1]).toMatchObject({
      scope: "project",
      projectId: "p-1",
    });
    // And the global row is untouched: nothing was restated.
    expect(state.entries[0].reinforcedAt).toBeUndefined();
  });

  it("widening a project fact leaves that project's row alone", () => {
    // The other direction of the same rule. Removing the project row here
    // would be the app deleting a line the operator can see, which is theirs
    // to do (LAWS/MEMORY.md, Sovereignty).
    const text = "The release branch is release/2026.9";
    useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: "p-1" }, NOW);
    useMemoryStore.getState().remember({ text, scope: "global" }, NOW + 5);

    const state = useMemoryStore.getState();
    expect(state.entries.map((e) => e.scope)).toEqual(["project", "global"]);
    expect(state.entries[0].reinforcedAt).toBeUndefined();
  });

  it("still reinforces a restatement inside one project", () => {
    const text = "The release branch is release/2026.9";
    const first = useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: "p-1" }, NOW);
    const second = useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: "p-1" }, NOW + 5);

    expect(second).toBe(first);
    expect(useMemoryStore.getState().entries).toHaveLength(1);
    expect(useMemoryStore.getState().entries[0].reinforcedAt).toBe(NOW + 5);
  });

  it("keeps one project's row out of another project's way", () => {
    const text = "The release branch is release/2026.9";
    useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: "p-1" }, NOW);
    useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: "p-2" }, NOW + 5);

    expect(useMemoryStore.getState().entries.map((e) => e.projectId)).toEqual([
      "p-1",
      "p-2",
    ]);
  });
});

describe("memoryRememberRefusal", () => {
  it("names a secret by its shape and nothing else", () => {
    const refusal = memoryRememberRefusal(
      { text: `AKIA${"Q".repeat(16)}`, scope: "global" },
      "p-1",
    );
    expect(refusal).toEqual({ reason: "secret", shape: "aws-key" });
  });

  it("refuses a project fact when the session has no project", () => {
    expect(
      memoryRememberRefusal({ text: "Uses pnpm", scope: "project" }, null),
    ).toEqual({ reason: "no-project" });
  });

  it("refuses a statement that normalizes to nothing", () => {
    expect(
      memoryRememberRefusal({ text: "   ", scope: "global" }, null),
    ).toEqual({ reason: "blank" });
  });

  it("keeps a fact its session can hold", () => {
    expect(
      memoryRememberRefusal({ text: "Uses pnpm", scope: "project" }, "p-1"),
    ).toBeNull();
    expect(
      memoryRememberRefusal({ text: "Ivan pushes", scope: "global" }, null),
    ).toBeNull();
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

  it("files an agent's project fact even when the same line is global", () => {
    // The global row does not stand in for the project one: the fence asked
    // for a fact about this project, and the panel has to show one.
    useMemoryStore
      .getState()
      .remember({ text: "Uses pnpm", scope: "global" }, NOW);

    const result = useMemoryStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s-1",
        "p-1",
        request({ remember: [{ text: "Uses pnpm", scope: "project" }] }),
        NOW + 1,
      );

    expect(result.remembered).toBe(1);
    expect(useMemoryStore.getState().entries).toHaveLength(2);
    expect(useMemoryStore.getState().entries[1]).toMatchObject({
      scope: "project",
      projectId: "p-1",
    });
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

  it("keeps the line a refused replacement was meant to correct", () => {
    // A project fact from a session with no project is refused, and a
    // correction is one fact restated: applying the retirement anyway would
    // leave the operator with neither the old line nor the new one, and no
    // way to tell it had happened.
    useMemoryStore.setState({
      entries: [entry({ id: "old", text: "The branch is main" })],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });

    const result = useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s",
      null,
      request({
        forget: ["The branch is main"],
        remember: [{ text: "The branch is release/2026.9", scope: "project" }],
      }),
      NOW,
    );

    expect(result).toEqual({ remembered: 0, forgotten: 0 });
    const state = useMemoryStore.getState();
    expect(state.entries.map((e) => e.id)).toEqual(["old"]);
    expect(state.archived).toEqual([]);
    // Still read once: the fence is not retried on every later store change.
    expect(state.appliedMessageIds).toContain("m-1");
  });

  it("holds back only the retirement whose own replacement was refused", () => {
    // The pairing is by index, so an unpaired `forget` — a plain retirement —
    // is not held hostage by another item's refusal.
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
        remember: [{ text: "The branch is release/2026.9", scope: "project" }],
      }),
      NOW,
    );

    const state = useMemoryStore.getState();
    expect(state.entries.map((e) => e.id)).toEqual(["old"]);
    expect(state.archived.map((e) => [e.id, e.archiveReason])).toEqual([
      ["stale", "forgotten"],
    ]);
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

describe("the archive the operator acts on", () => {
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

  describe("restoreArchived", () => {
    it("brings the line back as itself, not as a memory written today", () => {
      useMemoryStore.setState({
        archived: [
          archived({
            id: "old",
            text: "The branch is main",
            createdAt: 10,
            createdBySessionId: "s-1",
            archivedAt: 20,
          }),
        ],
      });

      useMemoryStore.getState().restoreArchived("old", NOW);

      const state = useMemoryStore.getState();
      expect(state.archived).toEqual([]);
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]).toMatchObject({
        id: "old",
        text: "The branch is main",
        createdAt: 10,
        createdBySessionId: "s-1",
        // Asked for back, which is what recency is a proxy for.
        reinforcedAt: NOW,
      });
      // And nothing of the archive's own bookkeeping travels with it.
      expect(state.entries[0]).not.toHaveProperty("archiveReason");
      expect(state.entries[0]).not.toHaveProperty("replacedById");
    });

    it("keeps a restored line in a full store instead of bouncing it back", () => {
      // Without the restore counting as a restatement, the cap would read the
      // returning line as the least recently useful one and archive it again
      // on the very same commit: the operator clicks and nothing happens.
      useMemoryStore.setState({
        entries: Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) =>
          entry({ id: `e-${index}`, text: `Fact ${index}`, createdAt: index }),
        ),
        archived: [
          archived({ id: "old", text: "An older fact", createdAt: 0 }),
        ],
      });

      useMemoryStore.getState().restoreArchived("old", NOW);

      const state = useMemoryStore.getState();
      expect(state.entries.some((e) => e.id === "old")).toBe(true);
      expect(state.entries).toHaveLength(MAX_MEMORY_ENTRIES);
      // The line the cap pushed out to make room is archived, not destroyed.
      expect(state.archived.map((e) => e.id)).toEqual(["e-0"]);
    });

    it("restates the live row instead of doubling a statement already kept", () => {
      useMemoryStore.setState({
        entries: [entry({ id: "live", text: "The branch is main" })],
        archived: [archived({ id: "old", text: "the BRANCH is main" })],
      });

      useMemoryStore.getState().restoreArchived("old", NOW);

      const state = useMemoryStore.getState();
      expect(state.entries.map((e) => e.id)).toEqual(["live"]);
      expect(state.entries[0].reinforcedAt).toBe(NOW);
      expect(state.archived).toEqual([]);
    });

    it("does nothing for a line that is not in the archive", () => {
      useMemoryStore.setState({
        entries: [entry({ id: "live" })],
        archived: [archived({ id: "old" })],
      });

      useMemoryStore.getState().restoreArchived("no-such-id", NOW);

      const state = useMemoryStore.getState();
      expect(state.entries.map((e) => e.id)).toEqual(["live"]);
      expect(state.archived.map((e) => e.id)).toEqual(["old"]);
    });
  });

  describe("deleteArchived", () => {
    it("destroys one archived line and leaves the rest of the archive", () => {
      useMemoryStore.setState({
        archived: [
          archived({ id: "doomed", text: "My home address" }),
          archived({ id: "keeper", text: "Something harmless" }),
        ],
      });

      useMemoryStore.getState().deleteArchived("doomed");

      expect(useMemoryStore.getState().archived.map((e) => e.id)).toEqual([
        "keeper",
      ]);
    });

    it("keeps it gone across a reload", async () => {
      useMemoryStore.setState({
        archived: [
          archived({ id: "doomed", text: "My home address" }),
          archived({ id: "keeper", text: "Something harmless" }),
        ],
      });

      useMemoryStore.getState().deleteArchived("doomed");
      await flushMemoryWrites();

      const stored = JSON.parse(
        window.localStorage.getItem(MEMORY_STORAGE_KEY) ?? "{}",
      );
      expect(parseArchivedMemoryEntries(stored).map((e) => e.text)).toEqual([
        "Something harmless",
      ]);
    });
  });

  describe("supersededChain", () => {
    it("follows a statement back through every wording it replaced", () => {
      const list = [
        archived({ id: "first", replacedById: "second" }),
        archived({ id: "second", replacedById: "live" }),
        archived({ id: "unrelated", archiveReason: "capacity" }),
      ];

      expect([...supersededChain(list, "live")]).toEqual(["second", "first"]);
    });

    it("names nothing for a line no archived wording points at", () => {
      expect(supersededChain([archived({ id: "a" })], "live").size).toBe(0);
    });
  });

  describe("the operator's delete and the archive behind it", () => {
    it("takes the earlier wordings of the deleted line with it", () => {
      // G2/F3: the row vanished and its predecessor stayed archived, so the
      // next recall answer handed the deleted statement straight back to the
      // agent. One row, one "forget", one outcome.
      useMemoryStore.setState({
        entries: [entry({ id: "live", text: "The branch is release/2026.10" })],
        archived: [
          archived({
            id: "second",
            text: "The branch is release/2026.9",
            archiveReason: "superseded",
            replacedById: "live",
          }),
          archived({
            id: "first",
            text: "The branch is main",
            archiveReason: "superseded",
            replacedById: "second",
          }),
        ],
      });

      useMemoryStore.getState().forget("live");

      const state = useMemoryStore.getState();
      expect(state.entries).toEqual([]);
      expect(state.archived).toEqual([]);
    });

    it("leaves archived lines the deleted one never replaced", () => {
      useMemoryStore.setState({
        entries: [entry({ id: "live", text: "The branch is release/2026.10" })],
        archived: [
          archived({
            id: "mine",
            text: "The branch is release/2026.9",
            archiveReason: "superseded",
            replacedById: "live",
          }),
          archived({
            id: "other",
            text: "Ivan is on holiday",
            archiveReason: "forgotten",
          }),
          archived({
            id: "displaced",
            text: "A fact pushed out to make room",
            archiveReason: "capacity",
          }),
        ],
      });

      useMemoryStore.getState().forget("live");

      expect(useMemoryStore.getState().archived.map((e) => e.id)).toEqual([
        "other",
        "displaced",
      ]);
    });
  });

  describe("forgetProject", () => {
    it("sweeps the project's live rows and its archive together", () => {
      // G2/F4: the panel filtered the live list and handed the rest to
      // `replaceAll`, which carries the archive across untouched — so a dead
      // project's archived rows stayed in the document for good, invisible and
      // unreachable, under a dialog promising the deletion could not be undone.
      useMemoryStore.setState({
        entries: [
          entry({ id: "g", text: "A global fact" }),
          entry({
            id: "live",
            text: "A live project fact",
            scope: "project",
            projectId: "p-live",
          }),
          entry({
            id: "dead",
            text: "A dead project fact",
            scope: "project",
            projectId: "p-gone",
          }),
        ],
        archived: [
          archived({ id: "g-old", text: "An old global fact" }),
          archived({
            id: "dead-old",
            text: "An old dead-project fact",
            scope: "project",
            projectId: "p-gone",
          }),
          archived({
            id: "live-old",
            text: "An old live-project fact",
            scope: "project",
            projectId: "p-live",
          }),
        ],
      });

      useMemoryStore.getState().forgetProject("p-gone");

      const state = useMemoryStore.getState();
      expect(state.entries.map((e) => e.id)).toEqual(["g", "live"]);
      expect(state.archived.map((e) => e.id)).toEqual(["g-old", "live-old"]);
    });

    it("leaves everything alone when asked to sweep no project at all", () => {
      useMemoryStore.setState({
        entries: [entry({ id: "g" })],
        archived: [archived({ id: "g-old" })],
      });

      useMemoryStore.getState().forgetProject("");

      const state = useMemoryStore.getState();
      expect(state.entries).toHaveLength(1);
      expect(state.archived).toHaveLength(1);
    });
  });
});
