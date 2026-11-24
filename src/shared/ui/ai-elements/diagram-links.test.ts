import { describe, expect, it, vi } from "vitest";
import { mermaidWithoutLinks, removeLinkTargets } from "./diagram-links";

const DESTINATION =
  "http://asset.localhost./C%3A%5CUsers%5Cinvented%5Cpage.html";

const upstream = vi.hoisted(() => {
  const instance = {
    initialize: vi.fn(),
    render: vi.fn(),
  };
  return { instance };
});

vi.mock("@streamdown/mermaid", () => ({
  mermaid: {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid: () => upstream.instance,
  },
}));

function parse(markup: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content;
}

describe("removeLinkTargets", () => {
  it("takes the destination out of a node link", () => {
    const rendered = parse(
      removeLinkTargets(
        `<svg id="diagram" viewBox="0 0 10 10"><a xlink:href="${DESTINATION}" data-look="classic"><g class="node clickable"><text>Open the report</text></g></a></svg>`,
      ),
    );

    const link = rendered.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttributeNames()).toEqual(["data-look"]);
    // The node itself is kept: only where it led is gone.
    expect(rendered.querySelector("g.node.clickable text")?.textContent).toBe(
      "Open the report",
    );
    expect(rendered.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 10 10",
    );
  });

  it("takes the destination out of a link written into a label", () => {
    const rendered = parse(
      removeLinkTargets(
        `<svg><foreignObject><div><a href="${DESTINATION}" target="_self">Open the report</a></div></foreignObject></svg>`,
      ),
    );

    const link = rendered.querySelector("a");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(link?.textContent).toBe("Open the report");
  });

  it("takes the destination out of an image map area and an SVG 2 link", () => {
    const rendered = parse(
      removeLinkTargets(
        `<svg><a href="${DESTINATION}"><text>node</text></a><foreignObject><map name="m"><area shape="rect" coords="0,0,9,9" href="${DESTINATION}"></map></foreignObject></svg>`,
      ),
    );

    expect(rendered.querySelectorAll("[href]")).toHaveLength(0);
    expect(rendered.querySelector("area")?.getAttribute("coords")).toBe(
      "0,0,9,9",
    );
  });

  it("leaves a diagram without links as it was", () => {
    const markup =
      '<svg id="diagram"><g class="node"><rect width="4" height="2"></rect><text>plain</text></g></svg>';

    expect(removeLinkTargets(markup)).toBe(markup);
  });
});

describe("mermaidWithoutLinks", () => {
  it("renders through Mermaid and hands back a diagram whose links lead nowhere", async () => {
    upstream.instance.render.mockResolvedValue({
      svg: `<svg><a xlink:href="${DESTINATION}"><text>node</text></a></svg>`,
      diagramType: "flowchart-v2",
    });

    const config = { theme: "dark" } as const;
    const instance = mermaidWithoutLinks.getMermaid(config);
    instance.initialize(config);
    const rendered = await instance.render("diagram-1", "flowchart LR");

    expect(upstream.instance.initialize).toHaveBeenCalledWith(config);
    expect(upstream.instance.render).toHaveBeenCalledWith(
      "diagram-1",
      "flowchart LR",
    );
    expect(rendered.svg).not.toContain("href");
    expect(rendered.svg).toContain("<text>node</text>");
    expect(rendered).toMatchObject({ diagramType: "flowchart-v2" });
  });

  it("stays the plugin Streamdown asks for by name", () => {
    expect(mermaidWithoutLinks.name).toBe("mermaid");
    expect(mermaidWithoutLinks.language).toBe("mermaid");
  });
});
