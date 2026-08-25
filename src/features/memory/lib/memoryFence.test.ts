import { describe, expect, it } from "vitest";

import {
  MAX_REMEMBER_PER_TURN,
  MEMORY_FENCE_TAG,
  MEMORY_PROTOCOL_PROMPT,
  parseMemoryFences,
} from "./memoryFence";

function fence(body: string): string {
  return ["Understood.", "", "```distill-memory", body, "```"].join("\n");
}

describe("parseMemoryFences", () => {
  it("has nothing to say about ordinary prose", () => {
    expect(parseMemoryFences("All done.")).toBeNull();
  });

  it("reads a scoped memory", () => {
    const parsed = parseMemoryFences(
      fence(
        '{"remember":[{"text":"The release branch is release/2026.9","scope":"project"}]}',
      ),
    );
    expect(parsed?.remember).toEqual([
      { text: "The release branch is release/2026.9", scope: "project" },
    ]);
  });

  it("keeps an unscoped memory to the project it was learned in", () => {
    // Global is the wide blast radius; a wrong one follows the operator into
    // every unrelated chat, so it has to be asked for explicitly.
    const parsed = parseMemoryFences(fence('{"remember":["Bare fact"]}'));
    expect(parsed?.remember[0]).toEqual({
      text: "Bare fact",
      scope: "project",
    });
  });

  it("takes global only when the block says so", () => {
    const parsed = parseMemoryFences(
      fence('{"remember":[{"text":"Ivan pushes","scope":"global"}]}'),
    );
    expect(parsed?.remember[0].scope).toBe("global");
  });

  it("collapses a multi-line statement into one line", () => {
    const parsed = parseMemoryFences(
      fence('{"remember":["first\\n\\nsecond"]}'),
    );
    expect(parsed?.remember[0].text).toBe("first second");
  });

  it("reads a correction as forget-then-remember", () => {
    const parsed = parseMemoryFences(
      fence('{"remember":["Branch is next"],"forget":["Branch is main"]}'),
    );
    expect(parsed?.forget).toEqual(["Branch is main"]);
    expect(parsed?.remember[0].text).toBe("Branch is next");
  });

  it("bounds one turn's enthusiasm", () => {
    const many = Array.from(
      { length: MAX_REMEMBER_PER_TURN + 4 },
      (_, index) => `"fact ${index}"`,
    ).join(",");
    const parsed = parseMemoryFences(fence(`{"remember":[${many}]}`));
    expect(parsed?.remember).toHaveLength(MAX_REMEMBER_PER_TURN);
  });

  it("merges every block in one message", () => {
    const parsed = parseMemoryFences(
      [fence('{"remember":["one"]}'), fence('{"forget":["two"]}')].join("\n"),
    );
    expect(parsed?.remember).toHaveLength(1);
    expect(parsed?.forget).toEqual(["two"]);
  });

  it("survives a block that is not JSON", () => {
    expect(parseMemoryFences(fence("remember everything"))).toBeNull();
  });

  it("can be called twice on the same text", () => {
    const text = fence('{"remember":["twice"]}');
    expect(parseMemoryFences(text)).toEqual(parseMemoryFences(text));
  });
});

describe("MEMORY_PROTOCOL_PROMPT", () => {
  it("documents a format the reader can actually read", () => {
    expect(MEMORY_PROTOCOL_PROMPT).toContain(MEMORY_FENCE_TAG);
    expect(parseMemoryFences(MEMORY_PROTOCOL_PROMPT)).not.toBeNull();
  });
});
