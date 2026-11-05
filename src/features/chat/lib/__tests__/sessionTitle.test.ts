import { describe, expect, it } from "vitest";

import { titleFromUserText } from "../sessionTitle";

describe("titleFromUserText", () => {
  it("keeps a short request as it is", () => {
    expect(titleFromUserText("Fix the failing parser test")).toBe(
      "Fix the failing parser test",
    );
  });

  it("names a long brief by its first sentence", () => {
    const brief =
      "Archive worker for D:/Work/Garden Planner. Read docs/index.md, notes/INVENTORY.md, tools/check.py, and earlier reviews as needed, then sort batch 7.";
    expect(titleFromUserText(brief)).toBe(
      "Archive worker for D:/Work/Garden Planner",
    );
  });

  it("does not end a sentence at a file name or an abbreviation", () => {
    const brief =
      "Read docs/index.md, notes/INVENTORY.md and tools/check.py, e.g. the parts on sorting, then list every field the planner stores and where it is read";
    const title = titleFromUserText(brief);
    expect(title.startsWith("Read docs/index.md, notes/INVENTORY.md")).toBe(
      true,
    );
    expect(title.endsWith("…")).toBe(true);
  });

  it("never leaves a cut hanging on a comma", () => {
    const brief =
      "Collect seed packets from shelf one, shelf two, shelf three, shelf four, shelf five, shelf six, shelf seven and shelf eight";
    const title = titleFromUserText(brief);
    expect(title).toMatch(/[^,\s]…$/u);
    expect(title.length).toBeLessThanOrEqual(101);
  });

  it("keeps a first question whole", () => {
    const brief =
      "Why does the planner forget the frost dates? It started after the last update and every bed shows the default season now, which breaks the reminders.";
    expect(titleFromUserText(brief)).toBe(
      "Why does the planner forget the frost dates?",
    );
  });

  it("does not take a two-word sentence as the name", () => {
    const brief =
      "Quick one. Check whether the planner keeps its frost dates when a bed is copied to another garden and the season is changed afterwards";
    expect(titleFromUserText(brief)).not.toBe("Quick one");
  });
});
