import { describe, expect, it } from "vitest";
import {
  buildEditorText,
  insertWorkingDir,
  parseEditorText,
} from "./projectPromptText";

describe("projectPromptText", () => {
  it("round-trips working directories and prompt text", () => {
    const text = buildEditorText(
      ["/tmp/one", "/tmp/two"],
      "Follow AGENTS.md\nThen fix the issue",
    );

    expect(parseEditorText(text)).toEqual({
      prompt: "Follow AGENTS.md\nThen fix the issue",
      workingDirs: ["/tmp/one", "/tmp/two"],
    });
  });

  it("adds a new directory to the bottom without moving existing prompt text", () => {
    expect(insertWorkingDir("include: /tmp/one\nPrompt body", "/tmp/two")).toBe(
      "include: /tmp/one\nPrompt body\n\ninclude: /tmp/two",
    );
  });
});
