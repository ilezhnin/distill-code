import { type DiagramPlugin, mermaid } from "@streamdown/mermaid";

const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/**
 * Takes the destinations out of the links in a rendered diagram.
 *
 * A Mermaid diagram can give a node a destination (`click A href "…"`) and a
 * label can carry an `<a>`. Streamdown puts the rendered diagram into the page
 * as markup, so these are plain anchors that never pass `MarkdownLink`: no
 * link-safety gate, no local-path gate. Following one takes the whole window
 * to wherever the diagram's author pointed it. An anchor without a
 * destination is text.
 *
 * `area` goes with `a`: a label may carry an image map, and an image elsewhere
 * in the same message can name it.
 */
export function removeLinkTargets(svg: string): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  for (const link of template.content.querySelectorAll("a, area")) {
    link.removeAttribute("href");
    link.removeAttribute("xlink:href");
    link.removeAttributeNS(XLINK_NAMESPACE, "href");
  }
  return template.innerHTML;
}

/** The Mermaid plugin, with the links of what it renders made inert. */
export const mermaidWithoutLinks: DiagramPlugin = {
  ...mermaid,
  getMermaid(config) {
    const instance = mermaid.getMermaid(config);
    return {
      initialize: (next) => instance.initialize(next),
      render: async (id, source) => {
        const rendered = await instance.render(id, source);
        return { ...rendered, svg: removeLinkTargets(rendered.svg) };
      },
    };
  },
};
