import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { VIRTUAL_ROW_LAYOUT_PENDING_SELECTOR } from "@/features/chat/transcript/measurement";
import {
  CODE_BLOCK_HIGHLIGHT_CHAR_LIMIT,
  CodeBlock,
  type CodeBlockLanguage,
  getCodeBlockTokenCacheStatsForTests,
  highlightCode,
  resetCodeBlockTokenCacheForTests,
} from "./code-block";

// Two >200-char sources with the same length and the same first/last 100
// characters, differing only in the middle: the canonical "one value edited
// in a config file" case.
const HEADER = `// ${"header ".repeat(20)}\n`;
const FOOTER = `\n// ${"footer ".repeat(20)}`;
const SOURCE_A = `${HEADER}const config = { retries: 3 };${FOOTER}`;
const SOURCE_B = `${HEADER}const config = { retries: 5 };${FOOTER}`;

async function highlightAndWait(
  code: string,
  language: CodeBlockLanguage = "typescript",
) {
  return new Promise<ReturnType<typeof highlightCode>>((resolve, reject) => {
    const cached = highlightCode(code, language, resolve, reject);
    if (cached) resolve(cached);
  });
}

function sourceOfLength(length: number, line = 'const value = "x";\n'): string {
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

describe("code-block token cache", () => {
  beforeEach(() => {
    resetCodeBlockTokenCacheForTests();
  });

  it("renders the code it was given even when a same-shaped source was highlighted before", async () => {
    await highlightAndWait(SOURCE_A);

    const { container } = render(
      <CodeBlock code={SOURCE_B} language="typescript" />,
    );

    const rendered = container.querySelector("pre")?.textContent ?? "";
    expect(rendered).toContain("retries: 5");
    expect(rendered).not.toContain("retries: 3");
  });

  it("keeps the cached sources under the character budget", async () => {
    // Twenty distinct sources just under the highlight limit add up to more
    // than the budget; the oldest are dropped to stay under it.
    for (let index = 0; index < 20; index += 1) {
      await highlightAndWait(
        `${index}\n${sourceOfLength(CODE_BLOCK_HIGHLIGHT_CHAR_LIMIT - 8, "plain text line\n")}`,
        "text",
      );
    }

    const stats = getCodeBlockTokenCacheStatsForTests();
    expect(stats.sourceChars).toBeLessThanOrEqual(1_000_000);
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.entries).toBeLessThan(20);
  });

  it("still caches small sources by count alone", async () => {
    await highlightAndWait(SOURCE_A);
    await highlightAndWait(SOURCE_B);

    expect(getCodeBlockTokenCacheStatsForTests().entries).toBe(2);
  });
});

describe("code-block highlight limit", () => {
  beforeEach(() => {
    resetCodeBlockTokenCacheForTests();
  });

  it("answers a source above the limit with its plain lines, without tokenizing or caching it", () => {
    const code = sourceOfLength(CODE_BLOCK_HIGHLIGHT_CHAR_LIMIT + 1);

    const plain = highlightCode(code, "typescript");

    expect(plain).not.toBeNull();
    expect(plain?.fg).toBe("inherit");
    expect(plain?.tokens).toHaveLength(code.split("\n").length);
    expect(plain?.tokens.every((line) => line.length <= 1)).toBe(true);
    expect(getCodeBlockTokenCacheStatsForTests().entries).toBe(0);
  });

  it("renders a source above the limit as plain text that is never pending", () => {
    const code = sourceOfLength(CODE_BLOCK_HIGHLIGHT_CHAR_LIMIT + 1);

    const { container } = render(
      <CodeBlock code={code} language="typescript" />,
    );

    expect(container.querySelectorAll("pre code > span")).toHaveLength(
      code.split("\n").length,
    );
    expect(container.querySelector("pre")?.textContent).toContain(
      'const value = "x";',
    );
    expect(
      container.querySelector(VIRTUAL_ROW_LAYOUT_PENDING_SELECTOR),
    ).toBeNull();
    expect(getCodeBlockTokenCacheStatsForTests().entries).toBe(0);
  });

  it("still highlights a source at the limit", async () => {
    const code = sourceOfLength(CODE_BLOCK_HIGHLIGHT_CHAR_LIMIT);

    const { container } = render(<CodeBlock code={code} language="text" />);
    expect(
      container.querySelector(VIRTUAL_ROW_LAYOUT_PENDING_SELECTOR),
    ).not.toBeNull();

    await highlightAndWait(code, "text");
    expect(getCodeBlockTokenCacheStatsForTests().entries).toBe(1);
  });
});
