import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SkillsGrid } from "../SkillsGrid";
import type { SkillInfo } from "../../api/skills";
vi.mock("../SkillCard", () => ({ SkillCard: () => <span>Skill</span> }));
it("reveals a large skill catalog without a delay proportional to its size", () => {
  const skills = Array.from(
    { length: 200 },
    (_, i) => ({ id: `invented-${i}`, name: `Skill ${i}` }) as SkillInfo,
  );
  const { container } = render(
    <SkillsGrid
      skills={skills}
      onSelectSkill={vi.fn()}
      onCreateSkill={vi.fn()}
    />,
  );
  const delays = [
    ...container.querySelectorAll<HTMLElement>(".gallery-card-enter"),
  ].map((card) => Number.parseFloat(card.style.animationDelay) || 0);
  expect(delays).toHaveLength(201);
  expect(Math.max(...delays)).toBeLessThanOrEqual(330);
  expect(delays.some((delay) => delay > 0)).toBe(true);
});
