import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MEMORY_WIKI_GRAPH_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { renderWithProviders } from "@/test/render";

const listProjectDocuments = vi.hoisted(() => vi.fn());
const readProjectDocument = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/projectStore", () => ({
  listProjectDocuments,
  readProjectDocument,
  writeProjectDocument: vi.fn(),
}));

import { resetProjectWikiPresenceForTests } from "../../lib/projectWikiPrompt";
import { WikiGraph } from "../WikiGraph";

const ROOT = "/work/quarp";

/** Three pages in the shape `distro/skills/project-wiki/SKILL.md` prescribes. */
const PAGES: Record<string, string> = {
  "retry-policy.md": `---
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
`,
  "goose-sidecar.md": `---
title: Goose sidecar
type: entity
updated: 2026-08-14
sources:
  - scripts/prepare-goose-sidecar.sh
---

# Goose sidecar

Retries are a [[retry-policy]] matter.
`,
  "colour-tokens.md": `---
title: Colour tokens
type: concept

# Colour tokens

Nothing links here.
`,
};

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p-1",
    path: `/projects/p-1`,
    name: "Quarp",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: [ROOT],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

function withWiki() {
  listProjectDocuments.mockImplementation(
    async (_root: string, path: string) =>
      path === "wiki"
        ? ["index.md", "log.md"]
        : path === "wiki/pages"
          ? Object.keys(PAGES)
          : [],
  );
  readProjectDocument.mockImplementation(async (_root: string, path: string) =>
    path.startsWith("wiki/pages/")
      ? (PAGES[path.slice("wiki/pages/".length)] ?? null)
      : null,
  );
}

describe("WikiGraph", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    resetProjectWikiPresenceForTests();
    listProjectDocuments.mockResolvedValue([]);
    readProjectDocument.mockResolvedValue(null);
    useProjectStore.setState({
      projects: [project()],
      hasFetchedProjects: true,
    });
  });

  it("draws a node per page and an edge per link once the experiment is on", async () => {
    withWiki();
    setExperimentEnabled(MEMORY_WIKI_GRAPH_EXPERIMENT_ID, true);

    renderWithProviders(<WikiGraph />);

    expect(await screen.findByTestId("wiki-graph")).toBeInTheDocument();
    const nodes = screen.getAllByTestId("wiki-graph-node");
    expect(nodes.map((node) => node.getAttribute("data-slug"))).toEqual([
      "colour-tokens",
      "goose-sidecar",
      "retry-policy",
    ]);
    expect(
      screen.getByTestId("wiki-graph").querySelectorAll("line"),
    ).toHaveLength(2);
  });

  it("marks the page nothing links to with the warning token", async () => {
    withWiki();
    setExperimentEnabled(MEMORY_WIKI_GRAPH_EXPERIMENT_ID, true);

    renderWithProviders(<WikiGraph />);
    await screen.findByTestId("wiki-graph");

    const nodes = screen.getAllByTestId("wiki-graph-node");
    const orphans = nodes.filter(
      (node) => node.getAttribute("data-orphan") === "true",
    );
    expect(orphans.map((node) => node.getAttribute("data-slug"))).toEqual([
      "colour-tokens",
    ]);
    expect(orphans[0].querySelector("circle")?.getAttribute("class")).toContain(
      "fill-warning",
    );
    // A linked page keeps its type's colour instead.
    const linked = nodes.find(
      (node) => node.getAttribute("data-slug") === "retry-policy",
    );
    expect(linked?.querySelector("circle")?.getAttribute("class")).toContain(
      "fill-chart-2",
    );
  });

  it("opens the page behind a node, exactly as it is on disk", async () => {
    withWiki();
    setExperimentEnabled(MEMORY_WIKI_GRAPH_EXPERIMENT_ID, true);
    const user = userEvent.setup();

    renderWithProviders(<WikiGraph />);
    await screen.findByTestId("wiki-graph");

    const node = screen
      .getAllByTestId("wiki-graph-node")
      .find(
        (candidate) => candidate.getAttribute("data-slug") === "goose-sidecar",
      );
    await user.click(node as Element);

    const drawer = await screen.findByTestId("wiki-graph-page");
    await waitFor(() => {
      expect(drawer.querySelector("pre")?.textContent).toContain(
        "[[retry-policy]]",
      );
    });
    expect(readProjectDocument).toHaveBeenCalledWith(
      ROOT,
      "wiki/pages/goose-sidecar.md",
    );
  });

  it("stays out of the panel while the experiment is off", async () => {
    withWiki();
    setExperimentEnabled(MEMORY_WIKI_GRAPH_EXPERIMENT_ID, false);

    const { container } = renderWithProviders(<WikiGraph />);

    await waitFor(() => {
      expect(listProjectDocuments).not.toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing at all when no project keeps a wiki", async () => {
    setExperimentEnabled(MEMORY_WIKI_GRAPH_EXPERIMENT_ID, true);

    const { container } = renderWithProviders(<WikiGraph />);

    await waitFor(() => {
      expect(listProjectDocuments).toHaveBeenCalledWith(ROOT, "wiki");
    });
    expect(container).toBeEmptyDOMElement();
  });
});
