import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

const mocks = vi.hoisted(() => ({
  openSessionDeepLink: vi.fn<(href: string) => Promise<boolean>>(),
}));

// The same door every other surface uses to get into an agent's chat
// (`berd://session/<id>` → the sessions open command); mocked here so the
// click can be asserted without the berdctl registry behind it.
vi.mock("@/features/sessions/lib/openSessionDeepLink", () => ({
  openSessionDeepLink: mocks.openSessionDeepLink,
}));

import type { MemoryEntry } from "../../lib/memoryEntry";
import { MAX_MEMORY_PROMPT_CHARS } from "../../lib/memoryPrompt";
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
    mocks.openSessionDeepLink.mockReset();
    mocks.openSessionDeepLink.mockResolvedValue(true);
    useMemoryStore.setState({ entries: [], appliedMessageIds: [] });
    useProjectStore.setState({ projects: [], hasFetchedProjects: false });
    useChatSessionStore.setState({
      sessions: [],
      hasHydratedSessions: false,
      hasMoreSessions: false,
    });
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

    // Wait out the dialog's dismissal (the repo-wide pattern for Radix
    // dialogs, see AppShell.navigation.test.tsx): while the closing dialog is
    // still mounted, "Forget this" matches both the row's trash button and
    // the dialog's confirm button.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

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

  it("offers to forget an orphaned project's memories, behind a confirmation", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [project("p-live", "Still here")],
      hasFetchedProjects: true,
    });
    useMemoryStore.setState({
      entries: [
        entry({ id: "g", text: "A global fact" }),
        entry({
          id: "live",
          text: "A live project fact",
          scope: "project",
          projectId: "p-live",
        }),
        entry({
          id: "dead-1",
          text: "First orphan",
          scope: "project",
          projectId: "p-gone",
        }),
        entry({
          id: "dead-2",
          text: "Second orphan",
          scope: "project",
          projectId: "p-gone",
        }),
      ],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    // Only the group whose project is gone offers the sweep.
    const forgetButtons = screen.getAllByTestId("memory-forget-project");
    expect(forgetButtons).toHaveLength(1);

    await user.click(forgetButtons[0]);
    // Nothing is deleted until the operator confirms.
    expect(useMemoryStore.getState().entries).toHaveLength(4);

    const dialog = await screen.findByRole("dialog");
    await user.click(
      await within(dialog).findByRole("button", { name: "Forget them" }),
    );

    const remaining = useMemoryStore.getState().entries.map((e) => e.id);
    expect(remaining).toEqual(["g", "live"]);
  });

  it("offers no orphan sweep before the project list has been fetched", () => {
    useProjectStore.setState({ projects: [], hasFetchedProjects: false });
    useMemoryStore.setState({
      entries: [
        entry({
          id: "maybe",
          text: "Might just not be loaded yet",
          scope: "project",
          projectId: "p-unknown",
        }),
      ],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    expect(screen.queryByTestId("memory-forget-project")).toBeNull();
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
  it("dates every row, and says when an agent last confirmed it", () => {
    const created = new Date("2026-03-04T10:00:00Z").getTime();
    const reinforced = new Date("2026-07-19T10:00:00Z").getTime();
    useMemoryStore.setState({
      entries: [
        entry({
          id: "plain",
          text: "Only ever written once",
          createdAt: created,
        }),
        entry({
          id: "restated",
          text: "Said again later",
          createdAt: created,
          reinforcedAt: reinforced,
        }),
      ],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    const rowOf = (id: string) => {
      const row = document.querySelector(`[data-entry-id="${id}"]`);
      if (!row) throw new Error(`no row for ${id}`);
      return row as HTMLElement;
    };
    const plainRow = rowOf("plain");
    const restatedRow = rowOf("restated");
    expect(within(plainRow).getByTestId("memory-entry-meta")).toHaveTextContent(
      "Everywhere · created Mar 4, 2026",
    );
    expect(
      within(restatedRow).getByTestId("memory-entry-meta"),
    ).toHaveTextContent(
      "Everywhere · created Mar 4, 2026 · confirmed Jul 19, 2026",
    );
  });

  it("names the project a scoped memory belongs to in its own row", () => {
    useProjectStore.setState({
      projects: [project("p-1", "Distill Code")],
      hasFetchedProjects: true,
    });
    useMemoryStore.setState({
      entries: [
        entry({
          id: "p",
          text: "A project fact",
          scope: "project",
          projectId: "p-1",
          createdAt: new Date("2026-01-02T10:00:00Z").getTime(),
        }),
      ],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    expect(screen.getByTestId("memory-entry-meta")).toHaveTextContent(
      "Distill Code · created Jan 2, 2026",
    );
  });

  it("offers no way into a chat for a memory the operator wrote", () => {
    useMemoryStore.setState({
      entries: [entry({ id: "mine", text: "I wrote this" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    expect(screen.queryByTestId("memory-from-agent")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open the chat that wrote this" }),
    ).toBeNull();
  });

  it("opens the writing agent's own chat from the badge", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [{ id: "s-1" } as never],
      hasHydratedSessions: true,
      hasMoreSessions: false,
    });
    useMemoryStore.setState({
      entries: [entry({ id: "a", createdBySessionId: "s-1" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    const link = screen.getByRole("link", {
      name: "Open the chat that wrote this",
    });
    expect(link).toHaveAttribute("href", "berd://session/s-1");

    await user.click(link);

    await waitFor(() => {
      expect(mocks.openSessionDeepLink).toHaveBeenCalledWith(
        "berd://session/s-1",
      );
    });
  });

  it("keeps the badge as plain text once the writing chat is gone", () => {
    useChatSessionStore.setState({
      sessions: [{ id: "s-other" } as never],
      hasHydratedSessions: true,
      hasMoreSessions: false,
    });
    useMemoryStore.setState({
      entries: [entry({ id: "a", createdBySessionId: "s-gone" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    const badge = screen.getByTestId("memory-from-agent");
    expect(badge.tagName).toBe("SPAN");
    expect(badge).toHaveAttribute(
      "title",
      "The chat that wrote this is no longer here.",
    );
    expect(
      screen.queryByRole("link", { name: "Open the chat that wrote this" }),
    ).toBeNull();
  });

  it("still offers the way in while the session list is only half loaded", () => {
    // "Not in the list" would be a lie here: the sidebar pages sessions in, so
    // the chat may simply not have been fetched yet.
    useChatSessionStore.setState({
      sessions: [],
      hasHydratedSessions: true,
      hasMoreSessions: true,
    });
    useMemoryStore.setState({
      entries: [entry({ id: "a", createdBySessionId: "s-unfetched" })],
      appliedMessageIds: [],
    });
    renderWithProviders(<MemorySettings />);

    expect(
      screen.getByRole("link", { name: "Open the chat that wrote this" }),
    ).toHaveAttribute("href", "berd://session/s-unfetched");
  });

  it("says why a draft carrying a key was refused, and keeps it in the field", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemorySettings />);

    const field = screen.getByTestId("memory-add-input");
    // A shape the redaction rules refuse; never a real credential.
    await user.type(field, "deploy token: abcdefghijklmnop");
    await user.click(screen.getByRole("button", { name: "Remember" }));

    expect(useMemoryStore.getState().entries).toHaveLength(0);
    expect(screen.getByTestId("memory-add-refusal")).toHaveTextContent(
      /not saved/,
    );
    // The operator can rephrase what they wrote instead of retyping it.
    expect(field).toHaveValue("deploy token: abcdefghijklmnop");

    await user.type(field, "!");
    expect(screen.queryByTestId("memory-add-refusal")).toBeNull();
  });

  it("clears the field and the objection once a draft is kept", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemorySettings />);

    const field = screen.getByTestId("memory-add-input");
    await user.type(field, "password: hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Remember" }));
    expect(screen.getByTestId("memory-add-refusal")).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "Ivan reviews Rust changes himself");
    await user.click(screen.getByRole("button", { name: "Remember" }));

    expect(screen.queryByTestId("memory-add-refusal")).toBeNull();
    expect(field).toHaveValue("");
    expect(useMemoryStore.getState().entries).toHaveLength(1);
  });

  describe("what the prompt block actually carries", () => {
    // Two lines this size cannot both fit in the budget, so the store holds
    // one memory the agents are told and one they are not.
    const halfBlock = "y".repeat(Math.floor(MAX_MEMORY_PROMPT_CHARS * 0.55));

    function crowdedStore() {
      useMemoryStore.setState({
        entries: [
          entry({ id: "kept", text: `Kept ${halfBlock}`, createdAt: 2 }),
          entry({ id: "dropped", text: `Dropped ${halfBlock}`, createdAt: 1 }),
        ],
        appliedMessageIds: [],
      });
    }

    const rowOf = (id: string) => {
      const row = document.querySelector(`[data-entry-id="${id}"]`);
      if (!row) throw new Error(`no row for ${id}`);
      return row as HTMLElement;
    };

    it("says of every line whether a session is told it", () => {
      crowdedStore();
      renderWithProviders(<MemorySettings />);

      expect(
        within(rowOf("kept")).getByTestId("memory-prompt-state"),
      ).toHaveTextContent("in the prompt");
      // Displaced, not lost — and the row says where it can still be reached
      // (LAWS/MEMORY.md, Reading back).
      expect(
        within(rowOf("dropped")).getByTestId("memory-prompt-state"),
      ).toHaveTextContent("crowded out — still found by search and recall");
    });

    it("counts the group's block against the budget it lives in", () => {
      crowdedStore();
      renderWithProviders(<MemorySettings />);

      const used = `Kept ${halfBlock}`.length + 3;
      expect(screen.getByTestId("memory-group-budget")).toHaveTextContent(
        `prompt block: ${used} / ${MAX_MEMORY_PROMPT_CHARS} characters`,
      );
    });

    it("judges a project's memories inside that project's own block", () => {
      useProjectStore.setState({
        projects: [project("p-1", "Distill Code")],
        hasFetchedProjects: true,
      });
      useMemoryStore.setState({
        entries: [
          entry({ id: "g", text: `Global ${halfBlock}`, createdAt: 5 }),
          entry({
            id: "scoped",
            text: `Scoped ${halfBlock}`,
            scope: "project",
            projectId: "p-1",
            createdAt: 1,
          }),
        ],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      // In a p-1 session the global line is the newer one and takes the
      // block, so the project's own memory is the one left out.
      expect(
        within(rowOf("scoped")).getByTestId("memory-prompt-state"),
      ).toHaveTextContent("crowded out");
      // The global group is measured on its own, where nothing competes.
      expect(
        within(rowOf("g")).getByTestId("memory-prompt-state"),
      ).toHaveTextContent("in the prompt");
    });
  });
});
