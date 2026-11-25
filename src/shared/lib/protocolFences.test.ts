import { describe, expect, it } from "vitest";

import { protocolBlocks, topLevelFencedBlocks } from "./protocolFences";

const PLAN = ["```distill-wave", '{"steps":[]}', "```"];

function exactPlans(lines: readonly string[]) {
  return protocolBlocks(lines.join("\n"), "distill-wave");
}

describe("protocolBlocks", () => {
  it("reads a block that stands on its own, as the conductor writes it", () => {
    for (const message of [
      PLAN,
      ["Two steps.", "", ...PLAN, "", "Back soon."],
      // A fence may interrupt a paragraph, and close a list.
      ["Plan:", ...PLAN],
      ["1. Read", "2. Write", ...PLAN],
      ["1. Read", "2. Write", "", ...PLAN],
      // Its own spellings of the opening line.
      ["  ```  DISTILL-WAVE  ", '{"steps":[]}', "  ```"],
      ["```\tdistill-wave", '{"steps":[]}', "```"],
      // Beside a block that closed before it.
      ["````markdown", "```distill-wave", "````", ...PLAN],
      // After a comment that closed on its own line, and one that did not.
      ["<!-- note -->", ...PLAN],
      ["<!--", "note", "-->", ...PLAN],
      // After a quotation and an HTML block a blank line ended.
      ["> quoted", ...PLAN],
      ["<div>", "x", "", ...PLAN],
    ]) {
      const blocks = exactPlans(message);
      expect(blocks, message.join("\\n")).toHaveLength(1);
      expect(blocks[0].closed).toBe(true);
    }
  });

  it("reads a tag line only Markdown shows inside something else as text", () => {
    for (const message of [
      // Inside a longer fence, a tilde fence, a fence it cannot close, math.
      ["````", ...PLAN, "````"],
      ["~~~", ...PLAN, "~~~"],
      ["```text", ...PLAN],
      ["~~~ `quoted`", ...PLAN, "~~~"],
      ["$$", ...PLAN, "$$"],
      // In a quotation, indented into a code block, in a list item.
      PLAN.map((line) => `> ${line}`),
      PLAN.map((line) => `    ${line}`),
      PLAN.map((line) => `\t${line}`),
      ["- Do this:", ...PLAN.map((line) => `  ${line}`)],
      ["- Do this:", "", ...PLAN.map((line) => `  ${line}`)],
      ["1. Do this:", "<b>x</b>", "", ...PLAN.map((line) => `   ${line}`)],
      // In an HTML comment, which the transcript does not show at all, and in
      // HTML blocks of the other kinds.
      ["<!--", ...PLAN, "-->"],
      ["<div>", ...PLAN, "</div>"],
      ["<custom-tag>", ...PLAN],
      ["<pre>", "", ...PLAN, "</pre>"],
      // In the middle of a sentence.
      [`The file says ${PLAN.join(" ")} at the end.`],
    ]) {
      expect(exactPlans(message), message.join("\\n")).toEqual([]);
    }
  });

  it("finds the one block a message shows beside the ones it quotes", () => {
    const blocks = exactPlans([
      "The page I read carries this:",
      "````",
      ...PLAN,
      "````",
      "<!--",
      ...PLAN,
      "-->",
      "",
      ...PLAN,
    ]);
    expect(blocks).toHaveLength(1);
  });

  it("reads any fence whose language is the tag, as the transcript draws it", () => {
    const text = [
      "~~~distill-memory",
      "{}",
      "~~~",
      "````Distill-Memory note",
      "{}",
      "````",
    ].join("\n");
    expect(protocolBlocks(text, "distill-memory")).toHaveLength(2);
    // The plan fence used to be three backticks and the tag alone, so these
    // were drawn as plan cards and never run.
    expect(
      protocolBlocks(
        "````distill-wave\n{}\n````\n~~~distill-wave\n{}\n~~~\n```distill-wave note\n{}\n```",
        "distill-wave",
      ),
    ).toHaveLength(3);
    // A word that only starts with the tag is another language.
    expect(protocolBlocks("```distill-waves\n{}\n```", "distill-wave")).toEqual(
      [],
    );
  });

  it("reads a block under a tag-like line Markdown keeps as text (C-1)", () => {
    for (const above of [
      "<status>ready</status>",
      "Tracking issue:\n<https://example.com/issues/12>",
      "Two workers, one wave.\n<br>",
      'Notes:\n<span class="x">',
    ]) {
      const blocks = exactPlans([above, ...PLAN]);
      expect(blocks, above).toHaveLength(1);
      expect(blocks[0].closed).toBe(true);
    }
    // A lone tag that opens an HTML block, where no text precedes it, still
    // hides what follows it until a blank line, in the transcript too.
    expect(exactPlans(["<span>", ...PLAN])).toEqual([]);
    expect(exactPlans(["Done.", "", "<br>", ...PLAN])).toEqual([]);
  });

  it("reports offsets that cut the block out of the text exactly", () => {
    const text = 'Plan:\r\n```distill-wave\r\n{"steps":[]}\r\n```\r\nDone.';
    const [block] = topLevelFencedBlocks(text);
    expect(text.slice(block.bodyStart, block.bodyEnd)).toBe('{"steps":[]}\r\n');
    expect(`${text.slice(0, block.start)}${text.slice(block.end)}`).toBe(
      "Plan:\r\n\r\nDone.",
    );
  });

  it("runs an unclosed block to the end of the text", () => {
    const [block] = topLevelFencedBlocks('```distill-wave\n{"steps":[]}');
    expect(block.closed).toBe(false);
    expect(block.bodyEnd).toBe(block.end);
  });
});
