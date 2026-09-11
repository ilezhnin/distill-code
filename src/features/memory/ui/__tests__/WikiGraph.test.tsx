import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { setMemoryWikiGraphEnabled } from "../../lib/memoryPreferences";
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

  it("draws a node per page and an edge per link once the graph is switched on", async () => {
    withWiki();
    setMemoryWikiGraphEnabled(true);

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
    setMemoryWikiGraphEnabled(true);

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
    setMemoryWikiGraphEnabled(true);
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

  it("reads nothing and draws nothing while the graph is switched off", async () => {
    withWiki();
    setMemoryWikiGraphEnabled(false);

    renderWithProviders(<WikiGraph />);

    expect(screen.getByTestId("wiki-graph-switch")).not.toBeChecked();
    await waitFor(() => {
      expect(listProjectDocuments).not.toHaveBeenCalled();
    });
    expect(screen.queryByTestId("wiki-graph")).not.toBeInTheDocument();
  });

  it("switches the graph on from the section itself", async () => {
    withWiki();
    setMemoryWikiGraphEnabled(false);
    const user = userEvent.setup();

    renderWithProviders(<WikiGraph />);
    await user.click(screen.getByTestId("wiki-graph-switch"));

    expect(await screen.findByTestId("wiki-graph")).toBeInTheDocument();
  });

  it("says so when no project keeps a wiki", async () => {
    setMemoryWikiGraphEnabled(true);

    renderWithProviders(<WikiGraph />);

    await waitFor(() => {
      expect(listProjectDocuments).toHaveBeenCalledWith(ROOT, "wiki");
    });
    expect(screen.getByTestId("wiki-graph-none")).toBeInTheDocument();
    expect(screen.queryByTestId("wiki-graph")).not.toBeInTheDocument();
  });
});
