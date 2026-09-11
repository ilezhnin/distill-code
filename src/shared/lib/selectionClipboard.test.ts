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
  it("keeps anchors so rich targets paste a clickable link", () => {
    const fragment = createFragment(
      `<p>See <a class="text-primary" data-streamdown="link" href="https://example.com">docs</a></p>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe(
      `<p>See <a href="https://example.com">docs</a></p>`,
    );
  });

  it("unwraps non-external anchors to their label", () => {
    const fragment = createFragment(
      `<p><a href="/local/report.md">report</a></p>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>report</p>");
  });

  it("unwraps app chrome wrappers but keeps their text", () => {
    const fragment = createFragment(
      `<div class="rounded-lg bg-muted"><span class="sr-only">kept</span></div>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("kept");
  });

  it("keeps classes and data attributes off preserved elements", () => {
    const fragment = createFragment(
      `<p class="mb-2" data-streamdown="paragraph">text</p>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>text</p>");
  });

  it("drops script and style content", () => {
    const fragment = createFragment(
      `<p>safe</p><script>alert(1)</script><style>p{color:red}</style>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>safe</p>");
  });

  it("escapes html special characters in text", () => {
    const fragment = createFragment("<p>a &lt; b &amp;&amp; c &gt; d</p>");

    expect(selectionFragmentToHtml(fragment)).toBe(
      "<p>a &lt; b &amp;&amp; c &gt; d</p>",
    );
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
