import { describe, expect, it } from "vitest";
import { formatArtifactFolderInstructions } from "./chatProjectContext";

describe("formatArtifactFolderInstructions", () => {
  it("tells agents not to markdown-embed a picture the image tool already showed", () => {
    const text = formatArtifactFolderInstructions(
      "C:/Users/Example/.distill/artifacts",
    );
    expect(text).toContain("C:/Users/Example/.distill/artifacts");
    expect(text).toContain("Do not also embed that same file in markdown");
    expect(text).toContain("![description](filename.ext)");
  });
});
