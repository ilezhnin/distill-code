/**
 * A project's wiki, read as a graph (M14).
 *
 * The pages are already the graph: `project-wiki`'s format gives every file a
 * slug, a type, and `[[slug]]` links to its neighbours, and the lint the skill
 * asks for — orphans, drifting clusters — is a question about edges that no
 * list of filenames can answer. So this module turns `.distill/wiki/pages/`
 * into nodes and edges once, and the surface above it only draws.
 *
 * Parsed line by line, with no YAML library, because the format says so: the
 * four frontmatter keys sit at the start of their own line, one value each,
 * and `sources:` is a list of indented items whose values may themselves
 * contain a colon (`- wave: 2026-08-31 retry comparison`). A real YAML parser
 * would read that item as a mapping and a hand-rolled `key: value` split would
 * read it as a fifth key; both are wrong, and both are avoided by the same
 * rule the skill states — a line that is indented, or starts a list item,
 * belongs to the key above it.
 *
 * Nothing here throws on a malformed page. A wiki is written by hand and by
 * agents, and the one page whose frontmatter someone broke is exactly the page
 * the operator wants to see on the picture — as an untyped node, not as a
 * missing one.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

import {
  listProjectDocuments,
  readProjectDocument,
} from "@/shared/api/projectStore";

import { PROJECT_WIKI_DIR } from "./projectWikiPrompt";

/** The four types `distro/skills/project-wiki/SKILL.md` allows. */
export const WIKI_PAGE_TYPES = [
  "entity",
  "concept",
  "decision",
  "report",
] as const;

export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

/** Where the pages live, relative to the project's `.distill` store. */
export const WIKI_PAGES_DIR = `${PROJECT_WIKI_DIR}/pages`;

/** One page, reduced to what a graph needs. */
export interface WikiPage {
  slug: string;
  title: string;
  /** `null` when the frontmatter is missing, broken, or names no known type. */
  type: WikiPageType | null;
  /** Every `[[slug]]` in the body, deduplicated, self-links dropped. */
  links: string[];
}

export interface WikiGraphNode extends WikiPage {
  /** Pages in this wiki that link here. */
  inbound: number;
  /** Links from here that land on a page this wiki actually has. */
  outbound: number;
  /** Nothing links here: the finding the skill's lint calls an orphan. */
  orphan: boolean;
}

export interface WikiGraphEdge {
  source: string;
  target: string;
}

export interface WikiGraphModel {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
}

/** A slug, as the skill defines it: the file stem and the id used everywhere. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

const WIKI_LINK_PATTERN = /\[\[([a-z0-9-]+)\]\]/g;

/** `key: value` at the start of a line — the only shape frontmatter has. */
const FRONTMATTER_ENTRY_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

function isWikiPageType(value: string): value is WikiPageType {
  return (WIKI_PAGE_TYPES as readonly string[]).includes(value);
}

/**
 * The frontmatter lines and the body, or the whole file as body.
 *
 * A file whose fence never closes has no frontmatter at all rather than a
 * frontmatter running to the end: the `[[links]]` further down are the part
 * worth keeping, and swallowing them into a header would drop the page's
 * edges over a missing `---`.
 */
function splitFrontmatter(source: string): {
  frontmatter: string[];
  body: string;
} {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: [], body: source };
  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (closing === -1) return { frontmatter: [], body: source };
  return {
    frontmatter: lines.slice(1, closing),
    body: lines.slice(closing + 1).join("\n"),
  };
}

/** The `[[slug]]` neighbours a body names, in the order they first appear. */
function readLinks(body: string, slug: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(WIKI_LINK_PATTERN)) {
    // A page linking to itself is a typo, not an edge, and a self-loop would
    // also make an orphan look like it has an inbound link.
    if (match[1] !== slug) links.add(match[1]);
  }
  return [...links];
}

/**
 * One page file, or `null` when its name is not a slug.
 *
 * The file stem is the id the index rows and every `[[link]]` use, so a file
 * that cannot be named that way cannot be linked to or from and has no place
 * on the picture.
 */
export function parseWikiPage(
  fileName: string,
  source: string,
): WikiPage | null {
  const slug = fileName.replace(/\.md$/i, "").trim();
  if (!SLUG_PATTERN.test(slug)) return null;

  const { frontmatter, body } = splitFrontmatter(source);
  let title = "";
  let type: WikiPageType | null = null;

  for (const line of frontmatter) {
    // An indented line, or a list item, is a value of the key above it —
    // `sources:` is the one that has them, and its `- wave: <date> <label>`
    // items would otherwise read as a key of their own.
    if (/^[ \t]/.test(line) || /^-[ \t]/.test(line)) continue;
    const entry = FRONTMATTER_ENTRY_PATTERN.exec(line);
    if (!entry) continue;
    const value = entry[2].trim();
    if (entry[1] === "title" && value) title = value;
    else if (entry[1] === "type" && isWikiPageType(value)) type = value;
  }

  return {
    slug,
    // The slug reads well enough as a name, and a page whose title was lost
    // with its frontmatter still has to be pointed at.
    title: title || slug,
    type,
    links: readLinks(body, slug),
  };
}

/**
 * Nodes and edges from a set of pages.
 *
 * Only links that land on a page this wiki has become edges: a `[[link]]` to a
 * slug nobody wrote is the skill's other lint finding, and inventing a node
 * for it would draw pages that do not exist. It also must not count towards
 * anything's inbound total, or a wiki of dead links would report no orphans.
 */
export function buildWikiGraph(pages: readonly WikiPage[]): WikiGraphModel {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const inbound = new Map<string, number>();
  const edges: WikiGraphEdge[] = [];

  // Sorted by slug so the same wiki always draws the same picture: the layout
  // below seeds node positions from their order.
  const ordered = [...bySlug.values()].sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );

  for (const page of ordered) {
    for (const link of page.links) {
      if (!bySlug.has(link)) continue;
      edges.push({ source: page.slug, target: link });
      inbound.set(link, (inbound.get(link) ?? 0) + 1);
    }
  }

  return {
    nodes: ordered.map((page) => {
      const count = inbound.get(page.slug) ?? 0;
      return {
        ...page,
        inbound: count,
        outbound: page.links.filter((link) => bySlug.has(link)).length,
        orphan: count === 0,
      };
    }),
    edges,
  };
}

/** Every page of one project's wiki, parsed. */
export async function readWikiPages(root: string): Promise<WikiPage[]> {
  const names = await listProjectDocuments(root, WIKI_PAGES_DIR);
  const pages = await Promise.all(
    names
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .map(async (name) => {
        const source = await readProjectDocument(
          root,
          `${WIKI_PAGES_DIR}/${name}`,
        );
        return source === null ? null : parseWikiPage(name, source);
      }),
  );
  return pages.filter((page): page is WikiPage => page !== null);
}

/** One page as it is on disk, for reading it whole. */
export function readWikiPageSource(
  root: string,
  slug: string,
): Promise<string | null> {
  return readProjectDocument(root, `${WIKI_PAGES_DIR}/${slug}.md`);
}

/**
 * The picture's coordinate space.
 *
 * A fixed viewBox rather than measured pixels: the SVG scales itself to
 * whatever width the panel gives it, so the layout never has to be recomputed
 * because a settings pane got narrower.
 */
export const WIKI_GRAPH_WIDTH = 640;
export const WIKI_GRAPH_HEIGHT = 380;

/** The smallest a node gets, and what each inbound link adds to it. */
const NODE_RADIUS_BASE = 7;
const NODE_RADIUS_PER_INBOUND = 2.5;
/**
 * Where growth stops. The size is a hint about how central a page is, and a
 * hub with thirty inbound links would otherwise cover the wiki it anchors.
 */
const NODE_RADIUS_INBOUND_CAP = 8;

/**
 * How far the simulation is run before the picture is taken.
 *
 * Ticked to completion in one go and never animated: this is a layout, not a
 * toy, and a settings panel that spends frames jiggling circles is spending
 * them on nothing the operator asked for. It also keeps the module callable
 * from a test without a clock.
 */
const LAYOUT_TICKS = 240;

export interface WikiGraphPlacement {
  node: WikiGraphNode;
  x: number;
  y: number;
  radius: number;
}

export interface WikiGraphLine {
  source: string;
  target: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WikiGraphLayout {
  width: number;
  height: number;
  nodes: WikiGraphPlacement[];
  lines: WikiGraphLine[];
}

/** A page's radius, from how many pages point at it. */
export function wikiNodeRadius(inbound: number): number {
  return (
    NODE_RADIUS_BASE +
    Math.min(inbound, NODE_RADIUS_INBOUND_CAP) * NODE_RADIUS_PER_INBOUND
  );
}

interface LayoutDatum extends SimulationNodeDatum {
  id: string;
  radius: number;
}

/**
 * Force-directed positions for one graph, computed once.
 *
 * Deterministic by construction: d3 seeds nodes in a fixed phyllotaxis spiral
 * from their order in the array, and `buildWikiGraph` sorts that array by
 * slug. The same wiki therefore draws the same picture on every open, which
 * is what makes "this cluster drifted off" a thing the operator can notice at
 * all.
 */
export function layoutWikiGraph(model: WikiGraphModel): WikiGraphLayout {
  const data: LayoutDatum[] = model.nodes.map((node) => ({
    id: node.slug,
    radius: wikiNodeRadius(node.inbound),
  }));
  // d3 rewrites a link's endpoints into node objects, so it gets its own
  // copies rather than the model's edges.
  const links: SimulationLinkDatum<LayoutDatum>[] = model.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));

  if (data.length > 0) {
    forceSimulation(data)
      .force(
        "link",
        forceLink<LayoutDatum, SimulationLinkDatum<LayoutDatum>>(links)
          .id((node) => node.id)
          .distance(70)
          .strength(0.4),
      )
      .force("charge", forceManyBody<LayoutDatum>().strength(-180))
      .force("center", forceCenter(WIKI_GRAPH_WIDTH / 2, WIKI_GRAPH_HEIGHT / 2))
      .force(
        "collide",
        forceCollide<LayoutDatum>().radius((node) => node.radius + 6),
      )
      .stop()
      .tick(LAYOUT_TICKS);
  }

  const placed = new Map<string, WikiGraphPlacement>();
  const nodes = model.nodes.map((node, index) => {
    const datum = data[index];
    const radius = datum.radius;
    // Clamped rather than scaled: a disconnected page drifts far from the
    // centre, and fitting the viewBox around it would squeeze every real
    // cluster into an unreadable knot in the middle.
    const placement: WikiGraphPlacement = {
      node,
      x: clamp(datum.x ?? WIKI_GRAPH_WIDTH / 2, radius + 2, WIKI_GRAPH_WIDTH),
      y: clamp(datum.y ?? WIKI_GRAPH_HEIGHT / 2, radius + 2, WIKI_GRAPH_HEIGHT),
      radius,
    };
    placed.set(node.slug, placement);
    return placement;
  });

  const lines: WikiGraphLine[] = [];
  for (const edge of model.edges) {
    const from = placed.get(edge.source);
    const to = placed.get(edge.target);
    if (!from || !to) continue;
    lines.push({
      source: edge.source,
      target: edge.target,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }

  return { width: WIKI_GRAPH_WIDTH, height: WIKI_GRAPH_HEIGHT, nodes, lines };
}

function clamp(value: number, margin: number, extent: number): number {
  if (!Number.isFinite(value)) return extent / 2;
  return Math.min(Math.max(value, margin), extent - margin);
}
