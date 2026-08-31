/**
 * The half of the checklist's memory block that is a panel, not a store.
 *
 * C.1, C.5 and C.6 in `night_checklist_v2.md` are about what Settings →
 * Memory shows and asks before it does anything: which group a new fact lands
 * under, that the trash button is a question rather than a deletion, and that
 * a project the operator no longer has is named as such and swept whole. The
 * store side of the same steps — the document, the reload, the archive — is
 * in `memoryScenarios.test.ts`.
 *
 * Written against roles and visible text on purpose: what a row says about
 * itself is being reworked, and these cases are about the panel's behaviour,
 * not its metadata line.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import { useMemoryStore } from "../stores/memoryStore";
import { MemorySettings } from "../ui/MemorySettings";

function project(id: string, name: string): ProjectInfo {
  return {
    id,
    path: `/projects/${id}`,
    name,
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
  };
}

/** The section a group's heading belongs to, so a row can be looked for in it. */
function group(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("section");
  if (!section) throw new Error(`The "${title}" heading has no section`);
  return section as HTMLElement;
}

beforeEach(() => {
  window.localStorage.clear();
  useMemoryStore.setState({
    entries: [],
    archived: [],
    appliedMessageIds: [],
    recallAnsweredMessageIds: [],
    hydrated: true,
  });
  useProjectStore.setState({ projects: [], hasFetchedProjects: true });
});

describe("C.1 — the operator remembers something", () => {
  it("puts an everywhere fact under Everywhere, editable, with a trash button", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [project("p-sandbox", "Sandbox")],
      hasFetchedProjects: true,
    });
    renderWithProviders(<MemorySettings />);

    // Checklist C.1.1: type the fact, leave the scope on "Everywhere", press
    // Remember.
    const text = "Ivan pushes himself, the agents have no credentials";
    await user.type(screen.getByLabelText("One short fact to keep"), text);
    await user.click(screen.getByRole("button", { name: "Remember" }));

    // C.1.2: a row under "Everywhere" — and only there.
    const everywhere = within(group("Everywhere"));
    expect(
      everywhere.getByRole("textbox", { name: "Edit this memory" }),
    ).toHaveValue(text);
    expect(
      everywhere.getByRole("button", { name: "Forget this" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("memory-entry")).toHaveLength(1);
    // The form is cleared, which is how the panel says the fact was taken.
    expect(screen.getByLabelText("One short fact to keep")).toHaveValue("");
  });
});

describe("C.5 — deleting takes a confirmation", () => {
  it("asks, names the fact, and then removes it for good", async () => {
    const user = userEvent.setup();
    useMemoryStore
      .getState()
      .remember({ text: "A fact typed by mistake", scope: "global" });
    useMemoryStore
      .getState()
      .remember({ text: "A fact worth keeping", scope: "global" });
    renderWithProviders(<MemorySettings />);

    const doomed = screen
      .getAllByTestId("memory-entry")
      .find((row) =>
        within(row).queryByDisplayValue("A fact typed by mistake"),
      );
    expect(doomed).toBeDefined();

    // Checklist C.5.1-C.5.2: the trash button opens a question that quotes the
    // statement, rather than deleting where it stands.
    await user.click(
      within(doomed as HTMLElement).getByRole("button", {
        name: "Forget this",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Forget this memory?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("A fact typed by mistake");
    expect(useMemoryStore.getState().entries).toHaveLength(2);

    // C.5.3: confirm, and it is gone from the panel and from the store —
    // with no archived copy, because the archive binds the app and not the
    // operator (LAWS/MEMORY.md, Sovereignty).
    await user.click(
      within(dialog).getByRole("button", { name: "Forget this" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("A fact typed by mistake"),
      ).not.toBeInTheDocument();
    });
    expect(
      useMemoryStore.getState().entries.map((entry) => entry.text),
    ).toEqual(["A fact worth keeping"]);
    expect(useMemoryStore.getState().archived).toHaveLength(0);
  });

  it("clears the archive the deleted line left behind it", async () => {
    // G2/F3 through the panel. The line the operator deletes is the third
    // wording of one fact; the two the agent replaced are in the archive, and
    // the archive is now a section on this page — so the operator can see
    // exactly what the question is about before answering it.
    const user = userEvent.setup();
    useMemoryStore.setState({
      entries: [
        {
          id: "live",
          text: "The release branch is release/2026.10",
          scope: "global",
          projectId: null,
          createdAt: 3,
          createdBySessionId: "s-agent",
        },
      ],
      archived: [
        {
          id: "second",
          text: "The release branch is release/2026.9",
          scope: "global",
          projectId: null,
          createdAt: 2,
          archivedAt: 3,
          archiveReason: "superseded",
          replacedById: "live",
        },
        {
          id: "first",
          text: "The release branch is main",
          scope: "global",
          projectId: null,
          createdAt: 1,
          archivedAt: 2,
          archiveReason: "superseded",
          replacedById: "second",
        },
      ],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: true,
    });
    renderWithProviders(<MemorySettings />);

    // Both earlier wordings are readable before anything is deleted.
    await user.click(screen.getByTestId("memory-archive-toggle"));
    expect(screen.getAllByTestId("memory-archive-entry")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Forget this" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("earlier wordings");
    await user.click(
      within(dialog).getByRole("button", { name: "Forget this" }),
    );

    await waitFor(() => {
      expect(useMemoryStore.getState().entries).toHaveLength(0);
    });
    // Nothing of the fact is left anywhere the operator can look, which is
    // what "this cannot be undone" promised.
    expect(useMemoryStore.getState().archived).toHaveLength(0);
    expect(screen.queryByTestId("memory-archive-toggle")).toBeNull();
  });
});

describe("C.6 — forgetting a project that no longer exists", () => {
  it("names the orphaned group and sweeps only it", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [project("p-live", "Still here")],
      hasFetchedProjects: true,
    });
    const memory = useMemoryStore.getState();
    memory.remember({
      text: "A fact that applies everywhere",
      scope: "global",
    });
    memory.remember({
      text: "A fact about the project that still exists",
      scope: "project",
      projectId: "p-live",
    });
    memory.remember({
      text: "The temporary project used pnpm",
      scope: "project",
      projectId: "p-gone",
    });
    memory.remember({
      text: "The temporary project was on Windows",
      scope: "project",
      projectId: "p-gone",
    });
    renderWithProviders(<MemorySettings />);

    // Checklist C.6.2: the group is named for what it is, and it is the only
    // one offering the sweep.
    const orphaned = within(group("A project that no longer exists"));
    expect(orphaned.getAllByTestId("memory-entry")).toHaveLength(2);
    expect(screen.getAllByTestId("memory-forget-project")).toHaveLength(1);

    // C.6.3: the button asks first.
    await user.click(orphaned.getByTestId("memory-forget-project"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Forget this project's memories?"),
    ).toBeInTheDocument();
    expect(useMemoryStore.getState().entries).toHaveLength(4);

    // C.6.4: the whole group goes, and nothing else is touched.
    await user.click(
      within(dialog).getByRole("button", { name: "Forget them" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "A project that no longer exists",
        }),
      ).not.toBeInTheDocument();
    });
    expect(
      useMemoryStore.getState().entries.map((entry) => entry.text),
    ).toEqual([
      "A fact that applies everywhere",
      "A fact about the project that still exists",
    ]);
    expect(
      within(group("Still here")).getByDisplayValue(
        "A fact about the project that still exists",
      ),
    ).toBeInTheDocument();
  });

  it("sweeps the dead project's archived lines with the rest of it", async () => {
    // G2/F4. Before this, the sweep filtered the live list and handed what was
    // left to `replaceAll`, which carries the archive across untouched: the
    // dead project's archived rows stayed in the document, in every mirror and
    // every backup, with no surface that named them.
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [project("p-live", "Still here")],
      hasFetchedProjects: true,
    });
    useMemoryStore.setState({
      entries: [
        {
          id: "dead-live",
          text: "The temporary project used pnpm",
          scope: "project",
          projectId: "p-gone",
          createdAt: 2,
        },
      ],
      archived: [
        {
          id: "dead-archived",
          text: "The temporary project was on Windows",
          scope: "project",
          projectId: "p-gone",
          createdAt: 1,
          archivedAt: 2,
          archiveReason: "forgotten",
        },
      ],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: true,
    });
    renderWithProviders(<MemorySettings />);

    await user.click(screen.getByTestId("memory-archive-toggle"));
    expect(
      screen.getByText("The temporary project was on Windows"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("memory-forget-project"));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Forget them" }),
    );

    await waitFor(() => {
      expect(useMemoryStore.getState().entries).toHaveLength(0);
    });
    expect(useMemoryStore.getState().archived).toHaveLength(0);
    expect(screen.queryByTestId("memory-archive-toggle")).toBeNull();
  });
});
