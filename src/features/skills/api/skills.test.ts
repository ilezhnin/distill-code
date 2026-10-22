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
        path: "/tmp/alpha/.distill/skills/test-writer",
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
      id: "project:/tmp/alpha/.distill/skills/test-writer",
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
        path: "/Users/test/.distill/skills/test-writer",
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
          path: "/Users/test/.distill/skills/imported",
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
        "/Users/test/.distill/skills/test-writer",
        "test-writer",
        "Writes tests",
        "Write tests",
        "blue",
      );
      await deleteSkill("/Users/test/.distill/skills/test-writer");
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

describe("bundled skill markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("keeps the previous builds' marker names beside the current one", async () => {
    // The app wrote the marker under two earlier names. A mechanical rename
    // that touched them would collapse the list into one repeated key and
    // make a skill marked by an earlier build editable.
    const { BUNDLED_SKILL_MARKER_KEYS } = await import("./skills");
    expect(BUNDLED_SKILL_MARKER_KEYS[0]).toBe("flockBundled");
    expect(BUNDLED_SKILL_MARKER_KEYS).toHaveLength(3);
    expect(new Set(BUNDLED_SKILL_MARKER_KEYS).size).toBe(
      BUNDLED_SKILL_MARKER_KEYS.length,
    );
  });

  it("a skill marked by an earlier build is read-only like a current one", async () => {
    const { BUNDLED_SKILL_MARKER_KEYS, listHostSourceSkills } = await import(
      "./skills"
    );
    const marked = BUNDLED_SKILL_MARKER_KEYS.map((key) => ({
      type: "skill",
      name: `marked-${key}`,
      description: "Installed by the app",
      content: "Body",
      path: `/Users/test/.distill/skills/marked-${key}`,
      global: true,
      properties: { [key]: true },
    }));
    mockGooseSourcesList.mockImplementation(
      async ({ type }: { type: string }) =>
        type === "skill"
          ? {
              sources: [
                ...marked,
                {
                  type: "skill",
                  name: "own",
                  description: "The user's",
                  content: "Body",
                  path: "/Users/test/.distill/skills/own",
                  global: true,
                  properties: { flockBundledSource: "marked-flockBundled" },
                },
              ],
            }
          : { sources: [] },
    );

    const skills = await listHostSourceSkills([]);

    expect(skills.map((skill) => [skill.name, skill.readonly])).toEqual([
      ...BUNDLED_SKILL_MARKER_KEYS.map((key) => [`marked-${key}`, true]),
      ["own", false],
    ]);
  });
});
