import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import {
  skillImportRefusalMessage,
  useSkillImportExport,
} from "./useSkillImportExport";

const mocks = vi.hoisted(() => ({
  sourcesImport: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    host: {
      sourcesImport: (...args: unknown[]) => mocks.sourcesImport(...args),
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** A picked file, as the import zone reads it. */
function pickedFile(contents: unknown, name = "notes.skill.json"): File {
  const bytes = new TextEncoder().encode(JSON.stringify(contents));
  return {
    name,
    type: "application/json",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

/** The host's answer to an import it refuses. */
function refusedBy(importRefused: Record<string, string>) {
  return {
    code: -32602,
    message: "The host's own English wording.",
    data: { importRefused },
  };
}

async function importFromTheSkillsScreen(file: File) {
  const onImportSuccess = vi.fn();
  const { result } = renderHook(() =>
    useSkillImportExport({ onImportSuccess }),
  );
  await act(async () => {
    await result.current.importFile(file);
  });
  await waitFor(() =>
    expect(
      vi.mocked(toast.success).mock.calls.length +
        vi.mocked(toast.error).mock.calls.length,
    ).toBe(1),
  );
  return onImportSuccess;
}

describe("importing from the Skills screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says which skill was created", async () => {
    mocks.sourcesImport.mockResolvedValue({
      sources: [
        {
          type: "skill",
          name: "release-notes",
          description: "Writes notes",
          content: "Do it.",
          path: "C:/Example/.flock/skills/release-notes",
          global: true,
        },
      ],
    });

    const onImportSuccess = await importFromTheSkillsScreen(
      pickedFile({ version: 1, type: "skill", name: "release-notes" }),
    );

    expect(mocks.sourcesImport).toHaveBeenCalledWith(
      expect.objectContaining({ type: "skill", target: { scope: "global" } }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Imported skill "release-notes"',
    );
    expect(onImportSuccess).toHaveBeenCalledTimes(1);
  });

  it("names both kinds when the file holds something else", async () => {
    mocks.sourcesImport.mockRejectedValue(
      refusedBy({ reason: "otherKind", expected: "skill", found: "agent" }),
    );

    const onImportSuccess = await importFromTheSkillsScreen(
      pickedFile({ version: 1, type: "agent", name: "Reviewer" }),
    );

    expect(toast.error).toHaveBeenCalledWith(
      "This file holds an agent, not a skill. Import it from Agents.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onImportSuccess).not.toHaveBeenCalled();
  });

  it("names the skill whose name the file would have taken", async () => {
    mocks.sourcesImport.mockRejectedValue(
      refusedBy({
        reason: "nameTaken",
        kind: "skill",
        name: "Release-Notes",
        existing: "release-notes",
      }),
    );

    await importFromTheSkillsScreen(
      pickedFile({ version: 1, type: "skill", name: "Release-Notes" }),
    );

    expect(toast.error).toHaveBeenCalledWith(
      'The name "Release-Notes" is already taken by the skill "release-notes". Rename or remove that skill, or change the name in the file.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not report success for something that is not a skill", async () => {
    // What the host used to answer: the agent the file held, already created.
    mocks.sourcesImport.mockResolvedValue({
      sources: [
        {
          type: "agent",
          name: "Reviewer",
          description: "d",
          content: "MARKER-PERSONA",
          path: "C:/Example/.flock/agents/reviewer-2.md",
          global: true,
        },
      ],
    });

    const onImportSuccess = await importFromTheSkillsScreen(
      pickedFile({ version: 1, type: "agent", name: "Reviewer" }),
    );

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(onImportSuccess).not.toHaveBeenCalled();
  });

  it("keeps the host's own words for any other failure", async () => {
    mocks.sourcesImport.mockRejectedValue({
      code: -32602,
      message: "Source description must not be empty",
    });

    await importFromTheSkillsScreen(pickedFile({ version: 1, name: "bare" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Source description must not be empty",
    );
  });

  it("has every refusal in both languages", async () => {
    const refusals = [
      { reason: "otherKind", found: "agent" },
      { reason: "otherKind", found: "project" },
      { reason: "otherKind", found: "unknown" },
      { reason: "nameTaken", name: "a", existing: "A" },
    ] as const;
    const said = new Set<string>();
    for (const locale of ["en", "es"]) {
      await i18n.changeLanguage(locale);
      for (const refusal of refusals) {
        const message = skillImportRefusalMessage(refusal);
        const text = i18n.t(message.key, { ns: "skills", ...message.options });
        expect(text).not.toBe(message.key);
        expect(text).not.toContain("{{");
        said.add(text);
      }
    }
    expect(said.size).toBe(refusals.length * 2);
  });
});
