import { describe, expect, it } from "vitest";
import { codeLanguageForPath } from "../artifactViewerLanguage";

describe("codeLanguageForPath", () => {
  it("maps common source extensions", () => {
    expect(codeLanguageForPath("src/app.tsx")).toBe("tsx");
    expect(codeLanguageForPath("lib.rs")).toBe("rust");
    expect(codeLanguageForPath("C:\\repo\\.gitignore")).toBe("ini");
  });

  it("maps extensionless config filenames", () => {
    expect(codeLanguageForPath("/repo/Dockerfile")).toBe("dockerfile");
    expect(codeLanguageForPath("/repo/Makefile")).toBe("make");
  });

  it("falls back to plaintext", () => {
    expect(codeLanguageForPath("/repo/LICENSE")).toBe("plaintext");
  });
});
