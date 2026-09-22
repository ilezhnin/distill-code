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
});
