import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "../../api/skills";
import { SkillsView } from "../SkillsView";

const skill: SkillInfo = {
  id: "release-notes",
  name: "Release notes",
  description: "Write release notes",
  instructions: "Start from the changelog.",
  path: "/home/me/.agents/skills/release-notes/SKILL.md",
  fileLocation: "/home/me/.agents/skills/release-notes/SKILL.md",
  sourceKind: "global",
  sourceLabel: "Personal",
  projectLinks: [],
  readonly: false,
  color: null,
};

const mocks = vi.hoisted(() => ({
  deleteSkill: vi.fn(async (..._args: unknown[]) => {}),
  listSkills: vi.fn(),
  updateSkill: vi.fn(),
}));

vi.mock("../../api/skills", async () => ({
  ...(await vi.importActual<typeof import("../../api/skills")>(
    "../../api/skills",
  )),
  deleteSkill: (...args: unknown[]) => mocks.deleteSkill(...args),
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
  updateSkill: (...args: unknown[]) => mocks.updateSkill(...args),
}));

vi.mock("../../lib/skillsEvents", () => ({
  listenSkillsChanged: () => () => {},
}));

vi.mock("../../lib/projectHydration", () => ({
  hydrateProjectNames: (skills: SkillInfo[]) => skills,
}));

vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SkillsView delete from the editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSkills.mockResolvedValue([skill]);
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  async function openEditorWithEdits(user: ReturnType<typeof userEvent.setup>) {
    render(<SkillsView activeSkillId={skill.id} />);
    await user.click(
      await screen.findByRole("button", { name: "common:actions.edit" }),
    );
    const instructions = await screen.findByPlaceholderText(
      "dialog.instructionsPlaceholder",
    );
    await user.type(instructions, " And the milestone.");
    return instructions;
  }

  it("keeps the editor and its unsaved edits when the delete is cancelled", async () => {
    const user = userEvent.setup();
    const instructions = await openEditorWithEdits(user);

    await user.click(
      screen.getByRole("button", { name: "common:actions.delete" }),
    );

    // The confirmation is up, and the editor is still behind it.
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText("view.deleteTitle")).toBeVisible();
    expect(instructions).toBeInTheDocument();

    await user.click(
      within(confirmation).getByRole("button", {
        name: "common:actions.cancel",
      }),
    );

    expect(mocks.deleteSkill).not.toHaveBeenCalled();
    expect(
      await screen.findByPlaceholderText("dialog.instructionsPlaceholder"),
    ).toHaveValue("Start from the changelog. And the milestone.");
  });

  it("closes the editor once the delete is confirmed", async () => {
    const user = userEvent.setup();
    await openEditorWithEdits(user);

    await user.click(
      screen.getByRole("button", { name: "common:actions.delete" }),
    );
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", {
        name: "common:actions.delete",
      }),
    );

    await waitFor(() => {
      expect(mocks.deleteSkill).toHaveBeenCalledWith(skill.path);
    });
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("dialog.instructionsPlaceholder"),
      ).toBeNull();
    });
  });
});
