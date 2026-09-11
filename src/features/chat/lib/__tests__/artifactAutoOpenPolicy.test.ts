import { describe, expect, it } from "vitest";
import { isWithinBase } from "../artifactAutoOpenPolicy";

const CWD = "/Users/dev/project";

describe("isWithinBase", () => {
  it("uses host-platform case semantics for Unix paths", () => {
    expect(isWithinBase("/users/dev/project", `${CWD}/a.md`, "mac")).toBe(true);
    expect(isWithinBase(CWD, "/USERS/DEV/PROJECT/a.md", "mac")).toBe(true);
    expect(isWithinBase("/users/dev/project", `${CWD}/a.md`, "linux")).toBe(
      false,
    );
    expect(isWithinBase(CWD, `${CWD}/a.md`, "linux")).toBe(true);
  });

  it("folds case for Windows drive/UNC paths", () => {
    expect(isWithinBase("C:\\Work", "c:/work/a.md")).toBe(true);
    expect(isWithinBase("\\\\server\\share", "//SERVER/SHARE/a.md")).toBe(true);
  });

  it("keeps the sibling-boundary guarantee", () => {
    expect(isWithinBase("/work", "/work-secrets/a.md")).toBe(false);
    expect(isWithinBase("C:\\Work", "C:/work-secrets/a.md")).toBe(false);
  });
});
