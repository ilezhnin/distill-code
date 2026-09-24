import { afterEach, describe, expect, it } from "vitest";

import { selectionFragmentToHtml } from "./selectionClipboard";

function createFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("selectionFragmentToHtml", () => {
  it("drops script and style content", () => {
    const fragment = createFragment(
      `<p>safe</p><script>alert(1)</script><style>p{color:red}</style>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>safe</p>");
  });

  it("escapes quotes in hrefs so the attribute cannot be broken out of", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", 'https://example.com/?q="onmouseover=x');
    anchor.textContent = "link";
    const fragment = document.createDocumentFragment();
    fragment.append(anchor);

    expect(selectionFragmentToHtml(fragment)).toBe(
      `<a href="https://example.com/?q=&quot;onmouseover=x">link</a>`,
    );
  });

  it("keeps list, table, and emphasis structure", () => {
    const fragment = createFragment(
      `<ul><li><strong>bold</strong> and <em>italic</em></li></ul>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe(
      "<ul><li><strong>bold</strong> and <em>italic</em></li></ul>",
    );
  });

  it("degrades non-remote images to their alt text", () => {
    const fragment = createFragment(
      `<img alt="diagram" src="asset://localhost/tmp/a.png" />`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("diagram");
  });
});
