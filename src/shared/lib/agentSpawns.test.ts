import { describe, expect, it } from "vitest";

import { parseSpawnLayers } from "./agentSpawns";

describe("parseSpawnLayers", () => {
  it("accepts an array of layer names in canonical order", () => {
    expect(parseSpawnLayers(["orchestrator", "worker"])).toEqual([
      "orchestrator",
      "worker",
    ]);
  });

  it("normalizes case, whitespace, ordering and duplicates", () => {
    expect(parseSpawnLayers([" Worker ", "ORCHESTRATOR", "worker"])).toEqual([
      "orchestrator",
      "worker",
    ]);
  });

  it("accepts a single layer name the way YAML scalars arrive", () => {
    expect(parseSpawnLayers("worker")).toEqual(["worker"]);
  });

  it("keeps the empty array: it is a real 'spawn nothing' override", () => {
    expect(parseSpawnLayers([])).toEqual([]);
  });

  it("rejects the whole value when any entry is not a layer", () => {
    // Partial acceptance would grant rights the author never wrote.
    expect(parseSpawnLayers(["worker", "supervisor"])).toBeUndefined();
    expect(parseSpawnLayers(["worker", 3])).toBeUndefined();
  });

  it("rejects non-list garbage", () => {
    expect(parseSpawnLayers("everything")).toBeUndefined();
    expect(parseSpawnLayers({ worker: true })).toBeUndefined();
    expect(parseSpawnLayers(null)).toBeUndefined();
    expect(parseSpawnLayers(undefined)).toBeUndefined();
    expect(parseSpawnLayers(7)).toBeUndefined();
  });
});
