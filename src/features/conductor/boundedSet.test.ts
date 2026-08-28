import { describe, expect, it } from "vitest";

import { BoundedSet } from "./boundedSet";

describe("BoundedSet", () => {
  it("behaves like a Set below the limit", () => {
    const set = new BoundedSet(3);
    set.add("a");
    set.add("b");
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("forgets the oldest entry rather than growing", () => {
    // The whole point: these live for the lifetime of the renderer, and the
    // failure they cause is not today's — it is the app left open for a week.
    const set = new BoundedSet(2);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("does not let a re-add renew an entry's age", () => {
    // These are "seen" marks. If re-adding refreshed them, the entries that
    // keep being re-seen would pin themselves and evict everything else.
    const set = new BoundedSet(2);
    set.add("a");
    set.add("b");
    set.add("a");
    set.add("c");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("deletes and clears", () => {
    const set = new BoundedSet(3);
    set.add("a");
    expect(set.delete("a")).toBe(true);
    expect(set.delete("a")).toBe(false);
    set.add("b");
    set.clear();
    expect(set.size).toBe(0);
  });

  it("survives a limit of one", () => {
    const set = new BoundedSet(1);
    set.add("a");
    set.add("b");
    expect(set.size).toBe(1);
    expect(set.has("b")).toBe(true);
  });
});
