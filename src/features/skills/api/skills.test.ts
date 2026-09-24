import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILLS_CHANGED_EVENT } from "../lib/skillsEvents";

const mockGooseSourcesList = vi.fn();
const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesDelete = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesImport = vi.fn();
const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    host: {
      sourcesList: (...args: unknown[]) => mockGooseSourcesList(...args),
      sourcesCreate: (...args: unknown[]) => mockGooseSourcesCreate(...args),
      sourcesDelete: (...args: unknown[]) => mockGooseSourcesDelete(...args),
      sourcesUpdate: (...args: unknown[]) => mockGooseSourcesUpdate(...args),
      sourcesImport: (...args: unknown[]) => mockGooseSourcesImport(...args),
    },
  }),
}));

describe("createSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("targets the project scope and maps a project skill", async () => {
    mockGooseSourcesCreate.mockResolvedValue({
      source: {
        type: "skill",
        name: "test-writer",
        description: "Writes tests",
        content: "Write tests",
        path: "/tmp/alpha/.agents/skills/test-writer",
        global: false,
        properties: { color: "blue" },
      },
    });

    const { createSkill } = await import("./skills");
    const skill = await createSkill(
      "test-writer",
      "Writes tests",
      "Write tests",
      "blue",
      { projectId: "alpha-project" },
    );

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { scope: "projectId", projectId: "alpha-project" },
      }),
    );
    expect(skill).toMatchObject({
      id: "project:/tmp/alpha/.agents/skills/test-writer",
      sourceKind: "project",
      sourceLabel: "alpha",
      projectLinks: [
        {
          id: "/tmp/alpha",
          name: "alpha",
          workingDir: "/tmp/alpha",
        },
      ],
    });
  });
});

describe("skill mutation events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("emits the skills changed event after successful update, delete, and import", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        type: "skill",
        name: "test-writer",
        description: "Writes tests",
        content: "Write tests",
        path: "/Users/test/.agents/skills/test-writer",
        global: true,
      },
    });
    mockGooseSourcesDelete.mockResolvedValue({});
    mockGooseSourcesImport.mockResolvedValue({
      sources: [
        {
          type: "skill",
          name: "imported",
          description: "Imported skill",
          content: "Imported instructions",
          path: "/Users/test/.agents/skills/imported",
          global: true,
        },
      ],
    });
    const listener = vi.fn();
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);

    try {
      const { deleteSkill, importSkills, updateSkill } = await import(
        "./skills"
      );
      await updateSkill(
        "/Users/test/.agents/skills/test-writer",
        "test-writer",
        "Writes tests",
        "Write tests",
        "blue",
      );
      await deleteSkill("/Users/test/.agents/skills/test-writer");
      await importSkills([123, 125], "IMPORTED.SKILL.JSON");

      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });

  it("does not emit the skills changed event when a mutation fails", async () => {
    mockGooseSourcesCreate.mockRejectedValue(new Error("permission denied"));
    const listener = vi.fn();
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);

    try {
      const { createSkill } = await import("./skills");
      await expect(
        createSkill("test-writer", "Writes tests", "Write tests", "blue"),
      ).rejects.toThrow("permission denied");

      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });
});
