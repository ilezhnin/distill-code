import { describe, expect, it } from "vitest";
import { deriveProjectRoot } from "./skillsPath";

describe("deriveProjectRoot", () => {
  it("resolves a project root from .agents/skills", () => {
    expect(deriveProjectRoot("/repo/.agents/skills/review")).toBe("/repo");
  });

  it("does not treat vendor skill folders as project skills", () => {
    expect(deriveProjectRoot("/repo/.claude/skills/review")).toBeNull();
    expect(deriveProjectRoot("/repo/.codex/skills/review")).toBeNull();
    expect(deriveProjectRoot("/repo/.gemini/skills/review")).toBeNull();
    expect(deriveProjectRoot("/repo/.goose/skills/review")).toBeNull();
  });
});
