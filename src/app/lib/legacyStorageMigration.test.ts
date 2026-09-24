import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "./legacyStorageMigration";

describe("migrateLegacyStorage", () => {
  beforeEach(() => localStorage.clear());

  it("keeps current keys untouched", () => {
    localStorage.setItem("distill:locale", "es");
    localStorage.setItem("distill.perf", "1");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("distill:locale")).toBe("es");
    expect(localStorage.getItem("distill.perf")).toBe("1");
  });

  it("renames goose-era keys", () => {
    localStorage.setItem("goose:memory", "[]");
    localStorage.setItem("goose.perf", "1");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("distill:memory")).toBe("[]");
    expect(localStorage.getItem("distill.perf")).toBe("1");
    expect(localStorage.getItem("goose:memory")).toBeNull();
    expect(localStorage.getItem("goose.perf")).toBeNull();
  });

  it("restores keys the broken rename moved, newest copy first", () => {
    localStorage.setItem("distillll:locale", "es");
    localStorage.setItem("goose:locale", "en");
    localStorage.setItem("distill:theme", "dark");
    localStorage.setItem("distillll:theme", "light");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("distill:locale")).toBe("es");
    expect(localStorage.getItem("distill:theme")).toBe("dark");
    expect(Object.keys(localStorage).sort()).toEqual([
      "distill:locale",
      "distill:theme",
    ]);
  });

  it("drops retired onboarding state", () => {
    localStorage.setItem("berd:onboarding:v1", "1");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("berd:onboarding:v1")).toBeNull();
  });
});
