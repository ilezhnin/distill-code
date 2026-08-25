import { beforeEach, describe, expect, it } from "vitest";

import type { MemoryEntry } from "../lib/memoryEntry";
import type { MemoryFenceRequest } from "../lib/memoryFence";
import {
  capEntries,
  flushMemoryWrites,
  MAX_MEMORY_ENTRIES,
  MEMORY_STORAGE_KEY,
  parseMemoryEntries,
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

describe("useMemoryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Hydration is what unlocks writing; outside the desktop app the document
    // layer falls back to the same localStorage key these cases read.
    useMemoryStore.setState({
      entries: [],
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

describe("capEntries", () => {
  it("drops the oldest past the bound", () => {
    const entries = Array.from({ length: MAX_MEMORY_ENTRIES + 1 }, (_, index) =>
      entry({ id: `e-${index}`, createdAt: index }),
    );
    const capped = capEntries(entries);
    expect(capped).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(capped.some((e) => e.id === "e-0")).toBe(false);
  });
});

describe("capEntries recency", () => {
  it("keeps a reinforced memory over a newer one that was never restated", () => {
    const entries = [
      entry({ id: "reinforced", createdAt: 0, reinforcedAt: 10_000 }),
      ...Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) =>
        entry({ id: `e-${index}`, createdAt: 100 + index }),
      ),
    ];

    const capped = capEntries(entries);
    expect(capped).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(capped.some((e) => e.id === "reinforced")).toBe(true);
    expect(capped.some((e) => e.id === "e-0")).toBe(false);
  });
});
