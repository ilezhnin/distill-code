import { describe, expect, it } from "vitest";
import { lastOutputLine } from "./toolOutputTail";

describe("lastOutputLine", () => {
  it("is the last non-empty line, whatever the line endings", () => {
    expect(
      lastOutputLine(
        "parsed 30076\r\nmat: 4000 materials\r\nmat: 30000 materials\r\n",
      ),
    ).toBe("mat: 30000 materials");
    expect(lastOutputLine("one\n\n  two  \n\n")).toBe("two");
  });

  it("is nothing for empty output", () => {
    expect(lastOutputLine("")).toBeNull();
    expect(lastOutputLine(undefined)).toBeNull();
    expect(lastOutputLine("\n \n")).toBeNull();
  });

  it("cuts a long line to the header's width", () => {
    const line = "x".repeat(200);
    const tail = lastOutputLine(line, 20);
    expect(tail).toHaveLength(20);
    expect(tail?.endsWith("…")).toBe(true);
  });
});
