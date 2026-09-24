import { describe, expect, it } from "vitest";

import { MAX_REMEMBER_PER_TURN, parseMemoryFences } from "./memoryFence";

function fence(body: string): string {
  return ["Understood.", "", "```distill-memory", body, "```"].join("\n");
}

describe("parseMemoryFences", () => {
  it("keeps an unscoped memory to the project it was learned in", () => {
    // Global is the wide blast radius; a wrong one follows the operator into
    // every unrelated chat, so it has to be asked for explicitly.
    const parsed = parseMemoryFences(fence('{"remember":["Bare fact"]}'));
    expect(parsed?.remember[0]).toEqual({
      text: "Bare fact",
      scope: "project",
    });
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

  it("survives a block that is not JSON", () => {
    expect(parseMemoryFences(fence("remember everything"))).toBeNull();
  });
});
