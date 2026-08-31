import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWikiGraph,
  layoutWikiGraph,
  parseWikiPage,
  readWikiPageSource,
  readWikiPages,
  WIKI_GRAPH_HEIGHT,
  WIKI_GRAPH_WIDTH,
  WIKI_PAGES_DIR,
  wikiNodeRadius,
  type WikiPage,
} from "./wikiGraph";

const listProjectDocuments = vi.hoisted(() => vi.fn());
const readProjectDocument = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/projectStore", () => ({
  listProjectDocuments,
  readProjectDocument,
  writeProjectDocument: vi.fn(),
}));

/**
 * Three pages in the exact shape `distro/skills/project-wiki/SKILL.md`
 * prescribes: a hub with a multi-line `sources:` list, a page that links to
 * it, and one whose frontmatter someone broke.
 */
const RETRY_POLICY = `---
title: Retry policy
type: concept
updated: 2026-08-31
sources:
  - src/net/retry.ts
  - wave: 2026-08-31 retry comparison
---

# Retry policy

## See also

- [[goose-sidecar]]
- [[missing-page]]
`;

const GOOSE_SIDECAR = `---
title: Goose sidecar
type: entity
updated: 2026-08-14
sources:
  - scripts/prepare-goose-sidecar.sh
---

# Goose sidecar

Staged by the bundle script. Retries are a [[retry-policy]] matter, and this
page names itself once, [[goose-sidecar]], which is not an edge.
`;

const BROKEN = `---
title: Half a header
type: concept

# Colour tokens

Nothing links here, and the frontmatter fence was never closed.
`;

const FIXTURE: Record<string, string> = {
  "retry-policy.md": RETRY_POLICY,
  "goose-sidecar.md": GOOSE_SIDECAR,
  "colour-tokens.md": BROKEN,
};

function fixturePages(): WikiPage[] {
  return Object.entries(FIXTURE).map(([name, source]) => {
    const page = parseWikiPage(name, source);
    if (!page) throw new Error(`fixture ${name} did not parse`);
    return page;
  });
}

describe("parseWikiPage", () => {
  it("reads the four frontmatter keys line by line", () => {
    expect(parseWikiPage("retry-policy.md", RETRY_POLICY)).toMatchObject({
      slug: "retry-policy",
      title: "Retry policy",
      type: "concept",
    });
  });

  it("steps over a multi-line sources list instead of reading its items as keys", () => {
    const page = parseWikiPage("retry-policy.md", RETRY_POLICY);

    // `- wave: 2026-08-31 retry comparison` is a source, not a `wave` key, and
    // must not overwrite the title or the type above it.
    expect(page?.title).toBe("Retry policy");
    expect(page?.type).toBe("concept");
  });

  it("collects every [[link]] once, without the page's own slug", () => {
    expect(parseWikiPage("goose-sidecar.md", GOOSE_SIDECAR)?.links).toEqual([
      "retry-policy",
    ]);
    expect(parseWikiPage("retry-policy.md", RETRY_POLICY)?.links).toEqual([
      "goose-sidecar",
      "missing-page",
    ]);
  });

  it("keeps a page whose frontmatter never closed, untyped and named by its slug", () => {
    expect(parseWikiPage("colour-tokens.md", BROKEN)).toEqual({
      slug: "colour-tokens",
      title: "colour-tokens",
      type: null,
      links: [],
    });
  });

  it("leaves out a type the skill does not define", () => {
    const page = parseWikiPage(
      "a.md",
      "---\ntitle: A\ntype: musings\n---\n\nbody\n",
    );
    expect(page?.type).toBeNull();
  });

  it("skips a file whose name is not a slug", () => {
    expect(parseWikiPage("Retry Policy.md", RETRY_POLICY)).toBeNull();
  });
});

describe("buildWikiGraph", () => {
  it("counts inbound links and marks the page nothing points at", () => {
    const graph = buildWikiGraph(fixturePages());

    expect(graph.nodes.map((node) => node.slug)).toEqual([
      "colour-tokens",
      "goose-sidecar",
      "retry-policy",
    ]);
    expect(
      graph.nodes.filter((node) => node.orphan).map((node) => node.slug),
    ).toEqual(["colour-tokens"]);
    expect(
      graph.nodes.find((node) => node.slug === "retry-policy"),
    ).toMatchObject({ inbound: 1, outbound: 1 });
  });

  it("draws no edge to a slug the wiki does not have", () => {
    const graph = buildWikiGraph(fixturePages());

    expect(graph.edges).toEqual([
      { source: "goose-sidecar", target: "retry-policy" },
      { source: "retry-policy", target: "goose-sidecar" },
    ]);
  });
});

describe("layoutWikiGraph", () => {
  it("places every node inside the picture and joins the edges it drew", () => {
    const layout = layoutWikiGraph(buildWikiGraph(fixturePages()));

    expect(layout.nodes).toHaveLength(3);
    for (const placement of layout.nodes) {
      expect(Number.isFinite(placement.x)).toBe(true);
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.x).toBeLessThanOrEqual(WIKI_GRAPH_WIDTH);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeLessThanOrEqual(WIKI_GRAPH_HEIGHT);
    }
    expect(layout.lines).toHaveLength(2);
  });

  it("is the same picture every time it is drawn", () => {
    const graph = buildWikiGraph(fixturePages());

    expect(layoutWikiGraph(graph).nodes.map((node) => node.x)).toEqual(
      layoutWikiGraph(graph).nodes.map((node) => node.x),
    );
  });

  it("grows a node with the pages that point at it, up to a cap", () => {
    expect(wikiNodeRadius(1)).toBeGreaterThan(wikiNodeRadius(0));
    expect(wikiNodeRadius(50)).toBe(wikiNodeRadius(8));
  });

  it("has nothing to place for a wiki with no pages", () => {
    expect(layoutWikiGraph({ nodes: [], edges: [] })).toMatchObject({
      nodes: [],
      lines: [],
    });
  });
});

describe("readWikiPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProjectDocuments.mockResolvedValue(Object.keys(FIXTURE));
    readProjectDocument.mockImplementation(
      async (_root: string, path: string) =>
        FIXTURE[path.replace(`${WIKI_PAGES_DIR}/`, "")] ?? null,
    );
  });

  it("reads the project's own pages folder", async () => {
    const pages = await readWikiPages("/work/quarp");

    expect(listProjectDocuments).toHaveBeenCalledWith(
      "/work/quarp",
      "wiki/pages",
    );
    expect(pages.map((page) => page.slug)).toEqual([
      "retry-policy",
      "goose-sidecar",
      "colour-tokens",
    ]);
  });

  it("ignores anything in the folder that is not a page", async () => {
    listProjectDocuments.mockResolvedValue([".DS_Store", "retry-policy.md"]);

    const pages = await readWikiPages("/work/quarp");

    expect(pages.map((page) => page.slug)).toEqual(["retry-policy"]);
  });

  it("reads one page whole for the operator to look at", async () => {
    await readWikiPageSource("/work/quarp", "retry-policy");

    expect(readProjectDocument).toHaveBeenCalledWith(
      "/work/quarp",
      "wiki/pages/retry-policy.md",
    );
  });
});
