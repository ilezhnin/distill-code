import { describe, expect, it } from "vitest";
import { createStarterHomeWidgets } from "./createStarterHomeWidgets";

describe("createStarterHomeWidgets", () => {
  it("does not seed a widget desktop", () => {
    expect(createStarterHomeWidgets([])).toEqual([]);
  });
});
