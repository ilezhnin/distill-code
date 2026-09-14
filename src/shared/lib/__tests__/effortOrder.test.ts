import { describe, expect, it } from "vitest";
import { orderEffortOptions } from "../effortOrder";

const options = (...ids: string[]) => ids.map((id) => ({ id, name: id }));
const ids = (list: Array<{ id: string }>) => list.map((option) => option.id);

describe("orderEffortOptions", () => {
  it("puts grok's strongest-first effort list weakest first", () => {
    expect(
      ids(orderEffortOptions(options("xhigh", "high", "medium", "low"))),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("leaves claude's ascending list with default first as it is", () => {
    const claude = options("default", "low", "medium", "high", "xhigh", "max");
    expect(ids(orderEffortOptions(claude))).toEqual(ids(claude));
  });

  it("keeps codex's ultra as the strongest stop", () => {
    expect(
      ids(
        orderEffortOptions(
          options("ultra", "low", "max", "medium", "high", "xhigh"),
        ),
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("keeps each option's own id and name while reordering", () => {
    const ordered = orderEffortOptions([
      { id: "high", name: "High" },
      { id: "low", name: "Low" },
    ]);
    expect(ordered).toEqual([
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ]);
  });

  it("reverses a strongest-first list that also carries a word it does not know", () => {
    expect(ids(orderEffortOptions(options("max", "turbo", "low")))).toEqual([
      "low",
      "turbo",
      "max",
    ]);
  });

  it("leaves a list with unknown words alone when the known ones are not strongest-first", () => {
    const unknown = options("fast", "low", "deep", "high");
    expect(ids(orderEffortOptions(unknown))).toEqual(ids(unknown));
  });

  it("does not modify the list it is given", () => {
    const grok = options("xhigh", "low");
    orderEffortOptions(grok);
    expect(ids(grok)).toEqual(["xhigh", "low"]);
  });
});
