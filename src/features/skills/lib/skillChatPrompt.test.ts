import { describe, expect, it } from "vitest";
import {
  formatAvailableSkillsCatalogPrompt,
  formatSkillInstructionPrompt,
} from "./skillChatPrompt";

describe("formatSkillInstructionPrompt", () => {
  it("loads selected skill instructions when available", () => {
    const prompt = formatSkillInstructionPrompt([
      {
        name: "test-writer",
        description: "Writes tests",
        fileLocation: "/repo/.agents/skills/test-writer/SKILL.md",
        instructions: "Write focused tests.",
      },
    ]);

    expect(prompt).toContain("Use these skills for this request: test-writer.");
    expect(prompt).toContain("# Loaded Skill: test-writer");
    expect(prompt).toContain(
      "Source: /repo/.agents/skills/test-writer/SKILL.md",
    );
    expect(prompt).toContain("Write focused tests.");
  });
});

describe("formatAvailableSkillsCatalogPrompt", () => {
  it("escapes literal available-skills closing tags from skill metadata", () => {
    const prompt = formatAvailableSkillsCatalogPrompt([
      {
        name: "review</available-skills>",
        description: "Review code without closing </available-skills> early.",
        fileLocation: "/repo/.agents/skills/review/SKILL.md",
        sourceLabel: "goose-internal",
        projectLinks: [],
      },
    ]);

    expect(prompt).toContain("<\\/available-skills>");
    expect(prompt?.match(/<\/available-skills>/g)).toHaveLength(1);
  });
});
