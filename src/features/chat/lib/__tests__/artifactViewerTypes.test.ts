import { describe, expect, it } from "vitest";
import {
  classifyArtifactView,
  fileExtension,
  isViewableArtifact,
} from "../artifactViewerTypes";

describe("fileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(fileExtension("/a/b/README.MD")).toBe(".md");
    expect(fileExtension("notes.Markdown")).toBe(".markdown");
  });

  it("handles paths with no extension", () => {
    expect(fileExtension("/a/b/Dockerfile")).toBe("");
    expect(fileExtension("/a/b/.gitignore")).toBe("");
  });

  it("normalizes windows separators", () => {
    expect(fileExtension("C:\\src\\image.PNG")).toBe(".png");
  });
});

describe("classifyArtifactView", () => {
  it("classifies markdown", () => {
    expect(classifyArtifactView("doc.md")).toBe("markdown");
    expect(classifyArtifactView("doc.mdx")).toBe("markdown");
    expect(classifyArtifactView("doc.markdown")).toBe("markdown");
  });

  it("classifies images", () => {
    for (const path of [
      "a.png",
      "a.jpg",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "a.svg",
    ]) {
      expect(classifyArtifactView(path)).toBe("image");
    }
  });

  it("classifies source and config files as code", () => {
    expect(classifyArtifactView("main.ts")).toBe("code");
    expect(classifyArtifactView("data.csv")).toBe("code");
    expect(classifyArtifactView("Dockerfile")).toBe("code");
    expect(classifyArtifactView(".gitignore")).toBe("code");
  });

  it("returns null for known binary files", () => {
    expect(classifyArtifactView("report.pdf")).toBeNull();
    expect(classifyArtifactView("archive.zip")).toBeNull();
    expect(classifyArtifactView("song.mp3")).toBeNull();
  });
});

describe("isViewableArtifact", () => {
  it("is true for previewable types and false for binaries", () => {
    expect(isViewableArtifact("a.md")).toBe(true);
    expect(isViewableArtifact("a.png")).toBe(true);
    expect(isViewableArtifact("a.ts")).toBe(true);
    expect(isViewableArtifact("a.pdf")).toBe(false);
  });
});
