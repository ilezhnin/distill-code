/**
 * The registry's end of settings search: a control nobody can find is a
 * control nobody has.
 */
import { describe, expect, it } from "vitest";

import { buildSettingsSearchResults } from "@/features/search/lib/searchResultModel";
import enSettings from "@/shared/i18n/locales/en/settings.json";

import { SETTINGS_SEARCH_ITEMS } from "./settingsSearchItems";

/** The same resolution SearchView does: every labelKey through `settings:`. */
function translate(key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      enSettings,
    );
  return typeof value === "string" ? value : key;
}

function idsFor(query: string): string[] {
  return buildSettingsSearchResults({
    query,
    enabled: true,
    translate,
    visibleSections: [{ id: "memory" as const, labelKey: "nav.memory" }],
  }).map((result) => result.id);
}

describe("SETTINGS_SEARCH_ITEMS", () => {
  it("gives every item a distinct id", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds the switch that stops agents writing memories", () => {
    expect(idsFor("agents can write")).toContain("memory-agent-writes");
    expect(idsFor("memories")).toContain("memory-agent-writes");
  });

  it("finds the switch that keeps memory out of prompts", () => {
    expect(idsFor("prompts")).toContain("memory-in-prompts");
    expect(idsFor("mix memory")).toContain("memory-in-prompts");
  });

  it("finds the memory review", () => {
    expect(idsFor("review")).toContain("memory-review");
    expect(idsFor("run a review")).toContain("memory-review");
  });

  // The word someone arriving with a CLAUDE.md types first, into a panel they
  // have no reason to know exists.
  it("finds the memory import", () => {
    expect(idsFor("import")).toContain("memory-import");
    expect(idsFor("import memories")).toContain("memory-import");
  });
});
