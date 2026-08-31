/**
 * The import parser, read against the files it actually meets: a hand-written
 * `CLAUDE.md` with headings, code and prose in it.
 */
import { describe, expect, it } from "vitest";

import { MAX_MEMORY_TEXT } from "./memoryEntry";
import { scanMemoryImport } from "./memoryImport";

/**
 * A `CLAUDE.md` of the ordinary kind, with one line in it that must never
 * reach the panel. The token is a shape, not a live credential.
 */
const CLAUDE_MD = [
  "# Project memory",
  "",
  "Notes Claude should carry into every session in this repo.",
  "",
  "## Conventions",
  "",
  "- Ivan reviews every Rust change himself",
  "- The release branch is `release/2026.9`",
  "- Never push straight to main",
  "",
  "## Environment",
  "",
  "- The CI token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "",
  "Run the suite before every push:",
  "",
  "```bash",
  "- this bullet is inside a fence",
  "just test",
  "```",
  "",
  "    just ci --strict",
  "",
  "---",
  "",
].join("\n");

describe("scanMemoryImport", () => {
  it("takes the bullets of a CLAUDE.md and leaves its scaffolding", () => {
    const scan = scanMemoryImport(CLAUDE_MD);

    expect(scan.candidates).toEqual([
      "Notes Claude should carry into every session in this repo.",
      "Ivan reviews every Rust change himself",
      "The release branch is `release/2026.9`",
      "Never push straight to main",
      "Run the suite before every push:",
    ]);
  });

  it("keeps headings, fenced code and indented code out of the list", () => {
    const candidates = scanMemoryImport(CLAUDE_MD).candidates;

    expect(candidates).not.toContain("Project memory");
    expect(candidates).not.toContain("Conventions");
    expect(candidates).not.toContain("just test");
    expect(candidates).not.toContain("this bullet is inside a fence");
    expect(candidates).not.toContain("just ci --strict");
  });

  it("drops a line carrying a token, and says only how many", () => {
    const scan = scanMemoryImport(CLAUDE_MD);

    expect(scan.refusedSecrets).toBe(1);
    // The one thing the import may never do is put the key back on screen.
    expect(scan.candidates.join("\n")).not.toContain("ghp_");
  });

  it("takes nested and numbered list items flat", () => {
    const scan = scanMemoryImport(
      [
        "- Releases",
        "  - Tags are signed",
        "    - By Ivan, with his own key",
        "1. First the changelog",
        "2) Then the tag",
      ].join("\n"),
    );

    expect(scan.candidates).toEqual([
      "Releases",
      "Tags are signed",
      "By Ivan, with his own key",
      "First the changelog",
      "Then the tag",
    ]);
  });

  it("strips a task list's checkbox, which is state and not statement", () => {
    expect(scanMemoryImport("- [x] Ship the release notes").candidates).toEqual(
      ["Ship the release notes"],
    );
    // A box with nothing after it is not a fact at all.
    expect(scanMemoryImport("- [ ]").candidates).toEqual([]);
  });

  it("leaves quoted material, tables and raw HTML alone", () => {
    const scan = scanMemoryImport(
      [
        "> The build failed with EACCES",
        "",
        "| Stage | Owner |",
        "| --- | --- |",
        "| Release | Ivan |",
        "",
        "<!-- a note to whoever edits this file -->",
      ].join("\n"),
    );

    expect(scan.candidates).toEqual([]);
  });

  it("skips the front matter a Codex memory file opens with", () => {
    const scan = scanMemoryImport(
      [
        "---",
        "created: 2026-08-30",
        "source: codex",
        "---",
        "",
        "- Deploys go out on Tuesdays",
      ].join("\n"),
    );

    expect(scan.candidates).toEqual(["Deploys go out on Tuesdays"]);
  });

  it("joins a statement that wrapped over two lines", () => {
    const scan = scanMemoryImport(
      ["- Ivan reviews every Rust change", "  himself, without exception"].join(
        "\n",
      ),
    );

    expect(scan.candidates).toEqual([
      "Ivan reviews every Rust change himself, without exception",
    ]);
  });

  it("offers the same statement once, however often the file says it", () => {
    const scan = scanMemoryImport(
      ["- Never push straight to main", "- never push straight to MAIN"].join(
        "\n",
      ),
    );

    expect(scan.candidates).toEqual(["Never push straight to main"]);
  });

  it("offers a long bullet as it would be stored, and drops a long paragraph", () => {
    const long = `${"word ".repeat(100)}end`;
    const fromBullet = scanMemoryImport(`- ${long}`);
    const fromParagraph = scanMemoryImport(long);

    expect(fromBullet.candidates).toHaveLength(1);
    expect(fromBullet.candidates[0]).toHaveLength(MAX_MEMORY_TEXT);
    // Prose is only taken while it is short enough to be a fact; the first 280
    // characters of an explanation are a fragment, not a memory.
    expect(fromParagraph.candidates).toEqual([]);
  });

  it("has nothing to offer from an empty file", () => {
    expect(scanMemoryImport("")).toEqual({
      candidates: [],
      refusedSecrets: 0,
    });
  });
});
