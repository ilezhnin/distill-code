import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_PREFIXES,
  RETIRED_KEYS,
  migrateLegacyStorage,
} from "./legacyStorageMigration";

// The former product name is spelled in two halves so a mechanical rename of
// the product cannot rewrite these expectations together with the table they
// guard: a sweep that turns a legacy row into `["flock:", "flock:"]` must
// fail here.
const PREVIOUS = ["dis", "till"].join("");

describe("migrateLegacyStorage", () => {
  beforeEach(() => localStorage.clear());

  it("pins the legacy prefix table, former spellings first", () => {
    expect(LEGACY_PREFIXES).toEqual([
      [`${PREVIOUS}:`, "flock:"],
      [`${PREVIOUS}.`, "flock."],
      [`${PREVIOUS}ll:`, "flock:"],
      ["goose:", "flock:"],
      ["goose.", "flock."],
    ]);
    expect(RETIRED_KEYS).toEqual(["goose:onboarding:v1", "berd:onboarding:v1"]);
  });

  it("keeps current keys untouched", () => {
    localStorage.setItem("flock:locale", "es");
    localStorage.setItem("flock.perf", "1");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("flock:locale")).toBe("es");
    expect(localStorage.getItem("flock.perf")).toBe("1");
  });

  it("adopts the previous product's keys without clobbering a newer copy", () => {
    localStorage.setItem(`${PREVIOUS}:chat-drafts`, '{"chat-1":"old draft"}');
    localStorage.setItem(`${PREVIOUS}:locale`, "es");
    localStorage.setItem(`${PREVIOUS}.perf`, "1");
    localStorage.setItem("flock:chat-drafts", '{"chat-1":"new draft"}');
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("flock:chat-drafts")).toBe(
      '{"chat-1":"new draft"}',
    );
    expect(localStorage.getItem("flock:locale")).toBe("es");
    expect(localStorage.getItem("flock.perf")).toBe("1");
    expect(Object.keys(localStorage).sort()).toEqual([
      "flock.perf",
      "flock:chat-drafts",
      "flock:locale",
    ]);
  });

  it("restores keys the broken rename moved, newest copy first", () => {
    localStorage.setItem(`${PREVIOUS}ll:locale`, "es");
    localStorage.setItem("goose:locale", "en");
    localStorage.setItem("flock:theme", "dark");
    localStorage.setItem(`${PREVIOUS}ll:theme`, "light");
    localStorage.setItem(`${PREVIOUS}:zoom`, "2");
    localStorage.setItem(`${PREVIOUS}ll:zoom`, "1");
    localStorage.setItem("goose:zoom", "0");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("flock:locale")).toBe("es");
    expect(localStorage.getItem("flock:theme")).toBe("dark");
    expect(localStorage.getItem("flock:zoom")).toBe("2");
    expect(Object.keys(localStorage).sort()).toEqual([
      "flock:locale",
      "flock:theme",
      "flock:zoom",
    ]);
  });

  it("drops retired onboarding flags", () => {
    for (const key of RETIRED_KEYS) localStorage.setItem(key, "1");
    migrateLegacyStorage(localStorage);
    expect(Object.keys(localStorage)).toEqual([]);
  });
});
