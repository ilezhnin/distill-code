import { describe, expect, it } from "vitest";
import { TerminalOutputBuffer } from "./terminalOutputBuffer";

describe("TerminalOutputBuffer", () => {
  it("drains what was written, in order", () => {
    const buffer = new TerminalOutputBuffer(100);
    buffer.push("abc");
    buffer.push("de");

    expect(buffer.length).toBe(5);
    expect(buffer.take(4)).toBe("abcd");
    expect(buffer.take(4)).toBe("e");
    expect(buffer.length).toBe(0);
    expect(buffer.take(4)).toBe("");
  });

  it("drops whole chunks off the front once full instead of re-copying the buffer", () => {
    const buffer = new TerminalOutputBuffer(1_000);
    buffer.push("OLDEST");
    for (let index = 0; index < 200; index++) {
      buffer.push("x".repeat(10));
    }

    expect(buffer.length).toBe(1_000);
    // 100 chunks of 10 chars, so pushing past the cap discards chunk-sized
    // blocks; at most the straddling chunk is re-sliced.
    expect(buffer.chunkCount).toBeLessThanOrEqual(101);

    const drained = buffer.take(1_000);
    expect(drained).toBe("x".repeat(1_000));
    expect(buffer.length).toBe(0);
  });

  it("trims only the chunk that straddles the cap", () => {
    const buffer = new TerminalOutputBuffer(10);
    buffer.push("123456");
    buffer.push("789012");

    expect(buffer.length).toBe(10);
    expect(buffer.take(10)).toBe("3456789012");
  });

  it("forgets everything on clear", () => {
    const buffer = new TerminalOutputBuffer(10);
    buffer.push("abc");
    buffer.clear();

    expect(buffer.length).toBe(0);
    expect(buffer.chunkCount).toBe(0);
    expect(buffer.take(5)).toBe("");
  });
});
