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

async function highlightAndWait(code: string) {
  return new Promise<ReturnType<typeof highlightCode>>((resolve, reject) => {
    const cached = highlightCode(code, "typescript", resolve, reject);
    if (cached) resolve(cached);
  });
}

describe("code-block token cache", () => {
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
