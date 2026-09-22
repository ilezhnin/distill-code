import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listProjectDocuments: vi.fn(),
}));

vi.mock("@/shared/api/projectStore", () => ({
  listProjectDocuments: (...args: unknown[]) =>
    mocks.listProjectDocuments(...args),
  readProjectDocument: vi.fn(),
  writeProjectDocument: vi.fn(),
}));

import {
  formatProjectResearchPrompt,
  PROJECT_RESEARCH_DIR,
  PROJECT_RESEARCH_INDEX_DOCUMENT,
  PROJECT_RESEARCH_POINTER_PROMPT,
  refreshProjectResearchPresence,
  resetProjectResearchPresenceForTests,
  knownProjectResearchPresence,
} from "./projectResearchPrompt";

describe("projectResearchPrompt", () => {
  beforeEach(() => {
    resetProjectResearchPresenceForTests();
    mocks.listProjectDocuments.mockReset();
  });

  it("emits the pointer when the project has a research index", async () => {
    mocks.listProjectDocuments.mockResolvedValue([
      PROJECT_RESEARCH_INDEX_DOCUMENT,
      "01-topic.md",
    ]);

    const present = await refreshProjectResearchPresence("/work/quarp");

    expect(present).toBe(true);
    expect(mocks.listProjectDocuments).toHaveBeenCalledWith(
      "/work/quarp",
      PROJECT_RESEARCH_DIR,
    );
    expect(formatProjectResearchPrompt(present)).toBe(
      PROJECT_RESEARCH_POINTER_PROMPT,
    );
  });

  it("emits nothing when the project has no research index", async () => {
    mocks.listProjectDocuments.mockResolvedValue(["01-topic.md"]);

    const present = await refreshProjectResearchPresence("/work/quarp");

    expect(present).toBe(false);
    expect(formatProjectResearchPrompt(present)).toBeUndefined();
  });

  it.each([
    true,
    false,
  ])("shares the pending listing instead of returning stale presence (%s)", async (present) => {
    let resolveListing!: (names: string[]) => void;
    mocks.listProjectDocuments.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveListing = resolve;
      }),
    );
    const first = refreshProjectResearchPresence("/work/quarp");
    const second = refreshProjectResearchPresence(" /work/quarp ");
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(mocks.listProjectDocuments).toHaveBeenCalledTimes(1);

    resolveListing(present ? ["index.md"] : []);
    expect(await Promise.all([first, second])).toEqual([present, present]);
    expect(knownProjectResearchPresence("/work/quarp")).toBe(present);
  });

  it.each([
    "deleted",
    "unavailable",
  ])("drops a %s index on refresh and recovers on a later listing", async (state) => {
    mocks.listProjectDocuments.mockResolvedValueOnce(["index.md"]);
    expect(await refreshProjectResearchPresence("/work/quarp")).toBe(true);
    if (state === "deleted")
      mocks.listProjectDocuments.mockResolvedValueOnce([]);
    else
      mocks.listProjectDocuments.mockRejectedValueOnce(
        new Error("Unavailable"),
      );
    expect(await refreshProjectResearchPresence("/work/quarp")).toBe(false);
    expect(knownProjectResearchPresence("/work/quarp")).toBe(false);
    mocks.listProjectDocuments.mockResolvedValueOnce(["index.md"]);
    expect(await refreshProjectResearchPresence("/work/quarp")).toBe(true);
  });
});
