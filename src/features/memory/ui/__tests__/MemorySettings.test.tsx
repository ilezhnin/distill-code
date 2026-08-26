import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import type { MemoryEntry } from "../../lib/memoryEntry";
import { useMemoryStore } from "../../stores/memoryStore";
import { MemorySettings } from "../MemorySettings";

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: 0,
    ...overrides,
  };
}

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

describe("MemorySettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMemoryStore.setState({ entries: [], appliedMessageIds: [] });
    useProjectStore.setState({ projects: [] });
  });

  it("says plainly when nothing has been kept", () => {
    renderWithProviders(<MemorySettings />);
    expect(screen.getByTestId("memory-empty")).toBeInTheDocument();
  });

  it("keeps a fact the operator types", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemorySettings />);

    await user.type(screen.getByTestId("memory-add-input"), "Ivan pushes");
    await user.click(screen.getByRole("button", { name: "Remember" }));

    const entries = useMemoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "Ivan pushes", scope: "global" });
  });

  it("shows every memory, whichever project it belongs to", () => {
    useMemoryStore.setState({
      entries: [
        entry({ id: "g", text: "Everywhere fact" }),
        entry({
          id: "p",
          text: "Project fact",
          scope: "project",
          projectId: "p-1",
        }),
      ],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    const rows = screen.getAllByTestId("memory-entry");
    expect(rows).toHaveLength(2);
  });

  it("marks what an agent put there", () => {
    useMemoryStore.setState({
      entries: [entry({ id: "a", createdBySessionId: "s-1" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    const row = screen.getByTestId("memory-entry");
    expect(within(row).getByTestId("memory-from-agent")).toBeInTheDocument();
  });

  it("keeps a fact scoped to a chosen project", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({ projects: [project("p-1", "Distill Code")] });
    renderWithProviders(<MemorySettings />);

    await user.type(screen.getByTestId("memory-add-input"), "Ivan reviews");
    await user.selectOptions(
      screen.getByTestId("memory-add-scope"),
      await screen.findByRole("option", { name: "Distill Code" }),
    );
    await user.click(screen.getByRole("button", { name: "Remember" }));

    const entries = useMemoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: "Ivan reviews",
      scope: "project",
      projectId: "p-1",
    });
  });

  it("only forgets a memory once the operator confirms", async () => {
    const user = userEvent.setup();
    useMemoryStore.setState({
      entries: [entry({ id: "a", text: "Wrong fact" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    await user.click(screen.getByRole("button", { name: "Forget this" }));

    // The trash button alone must not delete: the row is still there and the
    // confirmation is showing.
    expect(useMemoryStore.getState().entries).toHaveLength(1);
    const dialog = await screen.findByRole("dialog");

    await user.click(
      await within(dialog).findByRole("button", { name: "Cancel" }),
    );
    expect(useMemoryStore.getState().entries).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Forget this" }));
    const reopened = await screen.findByRole("dialog");
    await user.click(
      within(reopened).getByRole("button", { name: "Forget this" }),
    );

    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });

  it("shows an entry an agent rewrote while the page was open", async () => {
    useMemoryStore.setState({
      entries: [entry({ id: "a", text: "Old wording" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    expect(
      screen.getByRole("textbox", { name: "Edit this memory" }),
    ).toHaveValue("Old wording");

    // The agent sync applying a distill-memory correction goes through the
    // store, not through this page.
    act(() => {
      useMemoryStore.getState().updateEntry("a", "Corrected wording");
    });

    expect(
      screen.getByRole("textbox", { name: "Edit this memory" }),
    ).toHaveValue("Corrected wording");
  });

  it("saves an edit when the field loses focus", async () => {
    const user = userEvent.setup();
    useMemoryStore.setState({
      entries: [entry({ id: "a", text: "Old wording" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    const field = screen.getByRole("textbox", { name: "Edit this memory" });
    await user.clear(field);
    await user.type(field, "New wording");
    await user.tab();

    expect(useMemoryStore.getState().entries[0].text).toBe("New wording");
  });
});
