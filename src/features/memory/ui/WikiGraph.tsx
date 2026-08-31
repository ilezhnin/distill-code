/**
 * What a project knows, drawn (M14).
 *
 * A list of pages is a list of pages; a wiki is what its `[[links]]` make of
 * them. The findings `distro/skills/project-wiki/SKILL.md` asks a linting
 * agent to hunt for — the page nothing points at, the cluster that drifted
 * away from the rest — are properties of the edges, and the operator can see
 * both in a second on a picture that would cost a whole session to describe
 * in prose.
 *
 * Deliberately read-only. The law is explicit about who may write a page
 * (`LAWS/MEMORY.md`, "Project knowledge": the operator or the conductor's
 * loop), and a settings panel that edited the wiki from a circle would be a
 * third writer nobody agreed to. Clicking a node opens the page as it is on
 * disk, and that is the whole interaction.
 *
 * Behind the `memory-wiki-graph` experiment, and silent when there is nothing
 * to draw: a project with no `.distill/wiki/` gets no empty frame, because an
 * empty frame in a settings page reads as something broken rather than as
 * something absent.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MEMORY_WIKI_GRAPH_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SettingsSection } from "@/shared/ui/settings-section";

import { projectMemoryRoot } from "../lib/projectMemoryDocuments";
import { readProjectWikiPresence } from "../lib/projectWikiPrompt";
import {
  buildWikiGraph,
  layoutWikiGraph,
  readWikiPageSource,
  readWikiPages,
  WIKI_PAGE_TYPES,
  type WikiPage,
  type WikiPageType,
} from "../lib/wikiGraph";

/**
 * A colour per type, from the chart ramp.
 *
 * The one set of tokens in the design system that exists to tell categories
 * apart, and the only honest fit: nothing about `entity` is "success" and
 * nothing about `decision` is "info", so borrowing the status colours would
 * have said something untrue in both themes.
 */
const TYPE_FILL: Record<WikiPageType, string> = {
  entity: "fill-chart-1",
  concept: "fill-chart-2",
  decision: "fill-chart-3",
  report: "fill-chart-4",
};

/** A page whose frontmatter did not survive: present, and plainly unsorted. */
const UNTYPED_FILL = "fill-muted-foreground";

/**
 * An orphan overrides its type's colour.
 *
 * The type of a page nothing links to is the less interesting half of it —
 * the finding is that it is unreachable — so it is drawn in the warning token
 * and named in the legend rather than being left to blend into its category.
 */
const ORPHAN_FILL = "fill-warning";

interface WikiProject {
  id: string;
  name: string;
  root: string;
}

type LoadState = "loading" | "ready" | "failed";

export function WikiGraph() {
  const { t } = useTranslation("memory");
  const enabled =
    useExperiment(MEMORY_WIKI_GRAPH_EXPERIMENT_ID)?.enabled === true;
  const projects = useProjectStore((state) => state.projects);

  const [wikiProjects, setWikiProjects] = useState<WikiProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      projects
        .map((project) => ({
          id: project.id,
          name: project.name,
          root: projectMemoryRoot(project),
        }))
        .filter(
          (candidate): candidate is WikiProject => candidate.root !== null,
        ),
    [projects],
  );

  // Which projects have a wiki at all, asked the same way the prompt pointer
  // asks it. A project folder that cannot be listed simply has no wiki here.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        present: await readProjectWikiPresence(candidate.root),
      })),
    ).then((results) => {
      if (cancelled) return;
      setWikiProjects(
        results.filter((result) => result.present).map((r) => r.candidate),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [candidates, enabled]);

  // Whichever the operator picked, or the first one that has a wiki. Resolved
  // here rather than written into state so a project losing its wiki while the
  // page is open cannot leave the selection pointing at nothing.
  const selected =
    wikiProjects.find((project) => project.id === selectedId) ??
    wikiProjects[0] ??
    null;
  const selectedRoot = selected?.root ?? null;

  useEffect(() => {
    if (!selectedRoot) return;
    let cancelled = false;
    setState("loading");
    setOpenSlug(null);
    readWikiPages(selectedRoot)
      .then((read) => {
        if (cancelled) return;
        setPages(read);
        setState("ready");
      })
      .catch((error: unknown) => {
        console.error("[memory] could not read the project wiki:", error);
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoot]);

  // The page behind the node, read at the click. Nothing is cached: the wiki
  // is edited outside this app, and a body held from the last open would show
  // the operator a version of the page that is no longer on disk.
  useEffect(() => {
    if (!selectedRoot || !openSlug) {
      setOpenSource(null);
      return;
    }
    let cancelled = false;
    readWikiPageSource(selectedRoot, openSlug)
      .then((source) => {
        if (!cancelled) setOpenSource(source);
      })
      .catch((error: unknown) => {
        console.error("[memory] could not read a wiki page:", error);
        if (!cancelled) setOpenSource(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openSlug, selectedRoot]);

  const layout = useMemo(() => layoutWikiGraph(buildWikiGraph(pages)), [pages]);

  if (!enabled || !selected) return null;

  const typeLabel = (type: WikiPageType | null) =>
    type === null ? t("graph.types.unknown") : t(`graph.types.${type}`);

  return (
    <SettingsSection title={t("graph.title")}>
      <p className="text-xs text-muted-foreground">{t("graph.description")}</p>

      {/* One project's wiki at a time: the graph is about how one project's
          knowledge hangs together, and a picture merging two projects would
          draw clusters that never link to each other by construction. */}
      {wikiProjects.length > 1 ? (
        <select
          value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}
          aria-label={t("graph.project")}
          data-testid="wiki-graph-project"
          className="w-fit shrink-0 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
        >
          {wikiProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      ) : null}

      {state === "loading" ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="wiki-graph-loading"
        >
          {t("graph.reading")}
        </p>
      ) : state === "failed" ? (
        <p
          className="text-xs text-destructive"
          data-testid="wiki-graph-failed"
          role="alert"
        >
          {t("graph.failed")}
        </p>
      ) : layout.nodes.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="wiki-graph-empty"
        >
          {t("graph.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="min-w-0 flex-1 rounded-md border border-border bg-card"
            role="img"
            aria-label={t("graph.title")}
            data-testid="wiki-graph"
          >
            <g>
              {layout.lines.map((line) => (
                <line
                  key={`${line.source}->${line.target}`}
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  strokeWidth={1}
                  className="stroke-border"
                />
              ))}
            </g>
            <g>
              {layout.nodes.map(({ node, x, y, radius }) => (
                // biome-ignore lint/a11y/useSemanticElements: a node is a circle and its label inside the SVG's own coordinate space, which a native <button> cannot lay out
                <g
                  key={node.slug}
                  role="button"
                  tabIndex={0}
                  aria-label={t("graph.node", {
                    title: node.title,
                    type: typeLabel(node.type),
                    count: node.inbound,
                  })}
                  data-testid="wiki-graph-node"
                  data-slug={node.slug}
                  data-orphan={node.orphan}
                  className="cursor-pointer"
                  onClick={() => setOpenSlug(node.slug)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setOpenSlug(node.slug);
                  }}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={radius}
                    className={cn(
                      node.orphan
                        ? ORPHAN_FILL
                        : node.type
                          ? TYPE_FILL[node.type]
                          : UNTYPED_FILL,
                    )}
                  />
                  <text
                    x={x + radius + 4}
                    y={y + 3}
                    className="fill-muted-foreground text-[9px]"
                  >
                    {node.slug}
                  </text>
                </g>
              ))}
            </g>
          </svg>

          {/* The page itself, as it is on disk. Markdown left unrendered on
              purpose in this first pass: the frontmatter and the `[[links]]`
              are exactly what the operator came to check, and a renderer
              would hide both. */}
          {openSlug ? (
            <aside
              className="flex max-h-96 w-full min-w-0 flex-col gap-2 overflow-auto rounded-md border border-border bg-card p-3 md:w-80"
              data-testid="wiki-graph-page"
              data-slug={openSlug}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-sm text-foreground">
                  {openSlug}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  data-testid="wiki-graph-page-close"
                  onClick={() => setOpenSlug(null)}
                >
                  {t("graph.close")}
                </Button>
              </div>
              {openSource === null ? (
                <p className="text-xs text-muted-foreground">
                  {t("graph.pageUnreadable")}
                </p>
              ) : (
                <pre className="min-w-0 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                  {openSource}
                </pre>
              )}
            </aside>
          ) : null}
        </div>
      )}

      {/* What the colours mean. Without it the picture is decoration: a
          reader who cannot tell a decision from a report is left counting
          circles. */}
      {state === "ready" && layout.nodes.length > 0 ? (
        <ul
          className="flex list-none flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
          data-testid="wiki-graph-legend"
        >
          {WIKI_PAGE_TYPES.map((type) => (
            <li key={type} className="flex items-center gap-1">
              <svg viewBox="0 0 8 8" aria-hidden="true" className="size-2">
                <circle cx={4} cy={4} r={4} className={TYPE_FILL[type]} />
              </svg>
              {typeLabel(type)}
            </li>
          ))}
          <li className="flex items-center gap-1">
            <svg viewBox="0 0 8 8" aria-hidden="true" className="size-2">
              <circle cx={4} cy={4} r={4} className={ORPHAN_FILL} />
            </svg>
            {t("graph.orphan")}
          </li>
        </ul>
      ) : null}
    </SettingsSection>
  );
}
