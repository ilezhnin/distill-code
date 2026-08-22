import { describe, expect, it } from "vitest";
import { pickUniqueDisplayName } from "./pickUniqueDisplayName";

describe("pickUniqueDisplayName", () => {
  it("keeps the base name when it is free", () => {
    expect(pickUniqueDisplayName("Planner", ["Producer"])).toBe("Planner");
  });

  it("adds a numeric suffix when the base name is taken", () => {
    expect(pickUniqueDisplayName("Brigade", ["Brigade"])).toBe("Brigade 2");
    expect(pickUniqueDisplayName("Brigade", ["Brigade", "Brigade 2"])).toBe(
      "Brigade 3",
    );
  });
});
