import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";

import type { ArchivedMemoryEntry, MemoryEntry } from "../lib/memoryEntry";
import type { MemoryFenceRequest } from "../lib/memoryFence";
import {
  flushMemoryWrites,
  hydrateMemoryStore,
  MAX_MEMORY_ENTRIES,
  MEMORY_STORAGE_KEY,
  parseArchivedMemoryEntries,
  parseMemoryEntries,
  parseRecallAnsweredMessageIds,
  parseWaveExecutorSessionIds,
  resetWaveExecutorWatchForTests,
  useMemoryStore,
  watchGraphForWaveExecutors,
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

describe("hydrateMemoryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: false,
    });
  });

  it("reads the document even after an early change", async () => {
    window.localStorage.setItem(
      MEMORY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [entry({ id: "stored", text: "The stored fact" })],
        archived: [],
        appliedMessageIds: ["m-old"],
        recallAnsweredMessageIds: [],
      }),
    );
    useMemoryStore.getState().markRecallAnswered("q-early");
    useMemoryStore
      .getState()
      .remember({ text: "An early fact", scope: "global" }, NOW);
    // A change is not a read: until the document lands nothing may be
    // written, and the hydration must not be skipped.
    expect(useMemoryStore.getState().hydrated).toBe(false);

    await hydrateMemoryStore();

    const state = useMemoryStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.entries.map((item) => item.text)).toEqual([
      "The stored fact",
      "An early fact",
    ]);
    expect(state.appliedMessageIds).toEqual(["m-old"]);
    expect(state.recallAnsweredMessageIds).toEqual(["q-early"]);
    await flushMemoryWrites();
  });
});

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
});

describe("updateEntry", () => {
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

  it("refuses an edit that pastes a key into a line already kept", () => {
    // The edit field was the one way into the store that asked nothing, so a
    // token typed over an existing memory travelled into every later prompt
    // and into the project mirror (LAWS/MEMORY.md, Writing). A shape the
    // rules refuse; never a real credential.
    useMemoryStore.setState({
      entries: [entry({ id: "a", text: "The deploy runs on Fridays" })],
    });

    const verdict = useMemoryStore
      .getState()
      .updateEntry("a", `The deploy token is ghp_${"a".repeat(36)}`);

    expect(verdict).toEqual({ reason: "secret", shape: "github-token" });
    // And no edited version of it is kept in its place.
    expect(useMemoryStore.getState().entries[0].text).toBe(
      "The deploy runs on Fridays",
    );
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

    it("refuses to put a line carrying a secret back into the prompts", () => {
      // The archive has entrances `remember` never saw: a document written by
      // a build with no secret check, a project folder copied from another
      // machine. Restore is the click that would put such a line into every
      // prompt, so it answers to the same rule (LAWS/MEMORY.md, Writing).
      useMemoryStore.setState({
        archived: [
          archived({
            id: "leaky",
            text: `password: ${"z".repeat(12)}`,
            archivedAt: 20,
          }),
        ],
      });

      const verdict = useMemoryStore.getState().restoreArchived("leaky", NOW);

      expect(verdict).toEqual({
        reason: "secret",
        shape: "password-assignment",
      });
      expect(useMemoryStore.getState().entries).toEqual([]);
      // Refused, not destroyed: the row is still the operator's to read and
      // to delete for good.
      expect(useMemoryStore.getState().archived.map((e) => e.id)).toEqual([
        "leaky",
      ]);
    });
  });

  describe("deleteArchived", () => {
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

  describe("the operator's delete and the archive behind it", () => {
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
});

describe("the record of which sessions the wave engine owned", () => {
  /**
   * The conductor graph is bounded, and a finished wave child's node is the
   * first thing it evicts. The memory ACL's other default — "no node on the
   * graph is an ordinary operator chat" — then reads that child's transcript
   * as the operator's own, so the store keeps the fact the graph threw away.
   */
  beforeEach(() => {
    window.localStorage.clear();
    resetWaveExecutorWatchForTests();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      waveExecutorSessionIds: [],
      hydrated: true,
    });
    useConductorGraphStore.setState({ nodesById: {} });
  });

  afterEach(() => {
    resetWaveExecutorWatchForTests();
    useMemoryStore.setState({ waveExecutorSessionIds: [] });
    useConductorGraphStore.setState({ nodesById: {} });
  });

  function putWaveChild(sessionId: string) {
    useConductorGraphStore.setState((state) => ({
      nodesById: {
        ...state.nodesById,
        [sessionId]: {
          sessionId,
          projectId: "p-1",
          role: "worker",
          managedBy: "wave",
          parentSessionId: null,
          rootConductorId: null,
          runId: null,
          harnessId: "goose",
          displayName: "Worker",
          status: "completed",
        },
      },
    }));
  }

  it("remembers the record across a reload", async () => {
    putWaveChild("s-w");
    watchGraphForWaveExecutors();
    await flushMemoryWrites();

    const stored = JSON.parse(
      window.localStorage.getItem(MEMORY_STORAGE_KEY) ?? "{}",
    );
    expect(parseWaveExecutorSessionIds(stored)).toEqual(["s-w"]);
  });
});
