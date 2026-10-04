import { describe, expect, it } from "vitest";
import { deriveProjectRoot } from "./skillsPath";

describe("deriveProjectRoot", () => {
  it("finds the project that owns a skill in its .distill folder", () => {
    expect(deriveProjectRoot("/tmp/alpha/.distill/skills/test-writer")).toBe(
      "/tmp/alpha",
    );
    expect(
      deriveProjectRoot("C:\\work\\alpha\\.distill\\skills\\test-writer"),
    ).toBe("C:\\work\\alpha");
  });

  it("does not treat folders other tools keep as a project's skills", () => {
    for (const folder of [".agents", ".claude", ".codex", ".gemini"]) {
      expect(
        deriveProjectRoot(`/tmp/alpha/${folder}/skills/test-writer`),
      ).toBeNull();
    }
  });
});
