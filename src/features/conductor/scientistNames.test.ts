import { describe, expect, it } from "vitest";
import { pickUniqueScientistName, SCIENTIST_NAMES } from "./scientistNames";

describe("pickUniqueScientistName", () => {
  it("picks an unused scientist name", () => {
    const used = SCIENTIST_NAMES.slice(1);
    expect(pickUniqueScientistName(used, () => 0)).toBe(SCIENTIST_NAMES[0]);
  });

  it("adds a numeric suffix when every name is taken", () => {
    expect(pickUniqueScientistName(SCIENTIST_NAMES, () => 0)).toBe(
      `${SCIENTIST_NAMES[0]} 2`,
    );
  });
});
