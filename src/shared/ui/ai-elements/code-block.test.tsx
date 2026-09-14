import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeBlock, highlightCode } from "./code-block";

// Two >200-char sources with the same length and the same first/last 100
// characters, differing only in the middle: the canonical "one value edited
// in a config file" case.
const HEADER = `// ${"header ".repeat(20)}\n`;
const FOOTER = `\n// ${"footer ".repeat(20)}`;
const SOURCE_A = `${HEADER}const config = { retries: 3 };${FOOTER}`;
const SOURCE_B = `${HEADER}const config = { retries: 5 };${FOOTER}`;

function tokenText(tokens: { content: string }[][]): string {
  return tokens
    .map((line) => line.map((token) => token.content).join(""))
    .join("\n");
}

async function highlightAndWait(code: string) {
  return new Promise<ReturnType<typeof highlightCode>>((resolve, reject) => {
    const cached = highlightCode(code, "typescript", resolve, reject);
    if (cached) resolve(cached);
  });
}

describe("code-block token cache", () => {
  it("never serves tokens whose source differs from the requested code", async () => {
    expect(SOURCE_A).toHaveLength(SOURCE_B.length);
    expect(SOURCE_A.slice(0, 100)).toBe(SOURCE_B.slice(0, 100));
    expect(SOURCE_A.slice(-100)).toBe(SOURCE_B.slice(-100));

    const tokenizedA = await highlightAndWait(SOURCE_A);
    expect(tokenizedA).not.toBeNull();
    expect(tokenText(tokenizedA?.tokens ?? [])).toContain("retries: 3");

    // A is now cached; a synchronous lookup for it hits …
    expect(highlightCode(SOURCE_A, "typescript")).toBe(tokenizedA);
    // … but the same-shaped B must not be served A's tokens.
    const cachedForB = highlightCode(SOURCE_B, "typescript");
    expect(cachedForB).toBeNull();

    const tokenizedB = await highlightAndWait(SOURCE_B);
    expect(tokenText(tokenizedB?.tokens ?? [])).toContain("retries: 5");
    expect(tokenText(tokenizedB?.tokens ?? [])).not.toContain("retries: 3");
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
});
