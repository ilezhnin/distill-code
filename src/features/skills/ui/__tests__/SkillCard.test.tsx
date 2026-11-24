import { render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { i18n } from "@/shared/i18n";

import type { SkillInfo } from "../../api/skills";
import { SkillCard } from "../SkillCard";

beforeAll(async () => {
  await i18n.loadNamespaces(["skills", "common"]);
});

function skill(over: Partial<SkillInfo>): SkillInfo {
  return {
    id: "global:/flock/skills/review/SKILL.md",
    name: "review",
    description: "Reviews a change",
    instructions: "",
    path: "/flock/skills/review/SKILL.md",
    fileLocation: "/flock/skills/review",
    sourceKind: "global",
    sourceLabel: "Personal",
    projectLinks: [],
    readonly: false,
    color: null,
    ...over,
  };
}

it("says a skill comes from a project's folder, so it is not taken for the operator's own of the same name", () => {
  render(
    <>
      <SkillCard skill={skill({})} onSelect={vi.fn()} />
      <SkillCard
        skill={skill({
          id: "project:/work/sample/.distill/skills/review/SKILL.md",
          path: "/work/sample/.distill/skills/review/SKILL.md",
          sourceKind: "project",
          sourceLabel: "Sample Project",
          projectLinks: [
            {
              id: "/work/sample",
              name: "Sample Project",
              workingDir: "/work/sample",
              path: "/work/sample/.distill/skills/review/SKILL.md",
              fileLocation: "/work/sample/.distill/skills/review",
            },
          ],
        })}
        onSelect={vi.fn()}
      />
    </>,
  );
  const marks = screen.getAllByTestId("skill-from-project-folder");
  expect(marks).toHaveLength(1);
  expect(marks[0].textContent).toBe("From the folder of Sample Project");
});
