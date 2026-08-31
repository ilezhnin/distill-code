import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

const mocks = vi.hoisted(() => ({
  openSessionDeepLink: vi.fn<(href: string) => Promise<boolean>>(),
  dispatchCommand:
    vi.fn<(name: string, args: unknown, ctx: unknown) => Promise<unknown>>(),
  openFileDialog: vi.fn<(options: unknown) => Promise<string | null>>(),
  readTextFile: vi.fn<(path: string) => Promise<unknown>>(),
}));

// The same door every other surface uses to get into an agent's chat
// (`berd://session/<id>` → the sessions open command); mocked here so the
// click can be asserted without the berdctl registry behind it.
vi.mock("@/features/sessions/lib/openSessionDeepLink", () => ({
  openSessionDeepLink: mocks.openSessionDeepLink,
}));

// The review chat is created and opened through the berdctl registry, the
// same surface every other "start a chat with this in it" goes through. The
// registry itself pulls in half the app, so the two commands are asserted
// against a mock of it rather than run for real.
vi.mock("@/features/berdctl/commands/registry", () => ({
  dispatchCommand: mocks.dispatchCommand,
}));

// The import picks a file the way the rest of Settings picks one — the Tauri
// dialog plugin, then the app's own text read. Neither exists under jsdom, so
// both are mocked and the parser and the store run for real.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (options: unknown) => mocks.openFileDialog(options),
}));

vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    readTextFile: (path: string) => mocks.readTextFile(path),
  };
});

import type { ArchivedMemoryEntry, MemoryEntry } from "../../lib/memoryEntry";
import { getMemoryPreferences } from "../../lib/memoryPreferences";
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

function archivedEntry(
  overrides: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(overrides),
    archivedAt: 0,
    archiveReason: "capacity",
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

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

describe("MemorySettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.openSessionDeepLink.mockReset();
    mocks.openSessionDeepLink.mockResolvedValue(true);
    mocks.dispatchCommand.mockReset();
    mocks.dispatchCommand.mockResolvedValue({ session_id: "review-1" });
    mocks.openFileDialog.mockReset();
    mocks.readTextFile.mockReset();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
    });
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

  describe("the pause switches", () => {
    it("starts with memory travelling both ways", () => {
      renderWithProviders(<MemorySettings />);

      expect(screen.getByTestId("memory-write-switch")).toBeChecked();
      expect(screen.getByTestId("memory-read-switch")).toBeChecked();
    });

    it("stops agents writing without touching what is already kept", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({
        entries: [entry({ id: "kept", text: "A kept fact" })],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-write-switch"));

      expect(getMemoryPreferences()).toEqual({ write: false, read: true });
      // A pause is not a deletion (LAWS/MEMORY.md, Sovereignty): the list
      // below the switches is untouched.
      expect(useMemoryStore.getState().entries).toHaveLength(1);
      expect(screen.getByTestId("memory-entry")).toBeInTheDocument();
    });

    it("stops memory reaching prompts on its own switch", async () => {
      const user = userEvent.setup();
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-read-switch"));

      expect(getMemoryPreferences()).toEqual({ write: true, read: false });
      expect(screen.getByTestId("memory-read-switch")).not.toBeChecked();
      expect(screen.getByTestId("memory-write-switch")).toBeChecked();
    });

    it("switches back on again", async () => {
      const user = userEvent.setup();
      renderWithProviders(<MemorySettings />);

      const writeSwitch = screen.getByTestId("memory-write-switch");
      await user.click(writeSwitch);
      await user.click(writeSwitch);

      expect(getMemoryPreferences().write).toBe(true);
      expect(writeSwitch).toBeChecked();
    });
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

  describe("the area cards", () => {
    const DAY = 86_400_000;

    /** A group large enough to make the size default matter. */
    function facts(count: number) {
      return Array.from({ length: count }, (_, index) =>
        entry({
          id: `e-${index}`,
          text: `Fact number ${index}`,
          createdAt: index,
        }),
      );
    }

    it("counts an area and says when it last changed", () => {
      const now = Date.now();
      useMemoryStore.setState({
        entries: [
          entry({
            id: "old",
            text: "Written long ago",
            createdAt: now - 40 * DAY,
          }),
          // Restated three days ago, which is what "updated" is about: the
          // area changed then, even though nothing in it was created then.
          entry({
            id: "restated",
            text: "Said again recently",
            createdAt: now - 40 * DAY,
            reinforcedAt: now - 3 * DAY,
          }),
        ],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      expect(screen.getByTestId("memory-group-meta")).toHaveTextContent(
        "2 memories · updated 3 days ago",
      );
    });

    it("counts a single memory as one", () => {
      useMemoryStore.setState({
        entries: [entry({ id: "only", createdAt: Date.now() - DAY })],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      expect(screen.getByTestId("memory-group-meta")).toHaveTextContent(
        /^1 memory · /,
      );
    });

    it("leaves the area's own name as the whole heading", () => {
      // The page is navigated by these headings — here and in
      // `memoryScenarios.ui.test.tsx` — so the count and the date stay out of
      // the heading's accessible name.
      useMemoryStore.setState({
        entries: [entry({ id: "a", text: "A kept fact" })],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      expect(
        screen.getByRole("heading", { name: "Everywhere" }),
      ).toBeInTheDocument();
    });

    it("folds an area away and back, from the keyboard too", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({
        entries: [entry({ id: "a", text: "A kept fact" })],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      const toggle = screen.getByTestId("memory-group-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("memory-entry")).toBeInTheDocument();

      await user.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("memory-entry")).toBeNull();
      // A shut card still says what it holds, so folding one is never the
      // page losing track of it.
      expect(screen.getByTestId("memory-group-meta")).toHaveTextContent(
        "1 memory",
      );

      toggle.focus();
      await user.keyboard("{Enter}");

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("memory-entry")).toBeInTheDocument();
    });

    it("opens an area the operator can take in at a glance", () => {
      useMemoryStore.setState({ entries: facts(15), appliedMessageIds: [] });
      renderWithProviders(<MemorySettings />);

      expect(screen.getByTestId("memory-group-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getAllByTestId("memory-entry")).toHaveLength(15);
    });

    it("keeps a larger area folded until it is asked for", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({ entries: facts(16), appliedMessageIds: [] });
      renderWithProviders(<MemorySettings />);

      const toggle = screen.getByTestId("memory-group-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("memory-entry")).toBeNull();
      expect(screen.getByTestId("memory-group-meta")).toHaveTextContent(
        "16 memories",
      );

      await user.click(toggle);

      expect(screen.getAllByTestId("memory-entry")).toHaveLength(16);
    });
  });
  describe("the archive", () => {
    function archivedStore(entries: ArchivedMemoryEntry[]) {
      useMemoryStore.setState({
        entries: [],
        archived: entries,
        appliedMessageIds: [],
      });
    }

    it("stays shut until it is asked for, and says how much is in it", () => {
      archivedStore([
        archivedEntry({ id: "a", text: "A displaced fact" }),
        archivedEntry({ id: "b", text: "A retired fact" }),
      ]);
      renderWithProviders(<MemorySettings />);

      expect(
        screen.getByRole("heading", { name: "Archive (2)" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("memory-archive-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.queryByTestId("memory-archive-entry")).toBeNull();
    });

    it("says nothing at all while nothing has been displaced", () => {
      useMemoryStore.setState({
        entries: [entry({ id: "a" })],
        archived: [],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      expect(screen.queryByTestId("memory-archive-toggle")).toBeNull();
    });

    it("groups what it holds the way the live list is grouped", async () => {
      const user = userEvent.setup();
      useProjectStore.setState({
        projects: [project("p-1", "Distill Code")],
        hasFetchedProjects: true,
      });
      archivedStore([
        archivedEntry({ id: "g", text: "An everywhere fact" }),
        archivedEntry({
          id: "p",
          text: "A project fact",
          scope: "project",
          projectId: "p-1",
        }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));

      const groups = screen.getAllByTestId("memory-archive-group");
      expect(groups).toHaveLength(2);
      expect(within(groups[0]).getByText("Everywhere")).toBeInTheDocument();
      expect(within(groups[1]).getByText("Distill Code")).toBeInTheDocument();
      expect(screen.getAllByTestId("memory-archive-entry")).toHaveLength(2);
    });

    it("says of every line why it left, in all three of its ways", async () => {
      const user = userEvent.setup();
      archivedStore([
        archivedEntry({
          id: "capacity",
          text: "Pushed out to make room",
          archiveReason: "capacity",
          archivedAt: new Date("2026-03-04T10:00:00Z").getTime(),
        }),
        archivedEntry({
          id: "forgotten",
          text: "Retired by an agent",
          archiveReason: "forgotten",
          archivedAt: new Date("2026-03-04T10:00:00Z").getTime(),
        }),
        archivedEntry({
          id: "superseded",
          text: "Replaced by a correction",
          archiveReason: "superseded",
          archivedAt: new Date("2026-03-04T10:00:00Z").getTime(),
        }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));

      const rowOf = (id: string) => {
        const row = document.querySelector(`[data-archived-id="${id}"]`);
        if (!row) throw new Error(`no archived row for ${id}`);
        return row as HTMLElement;
      };
      expect(
        within(rowOf("capacity")).getByTestId("memory-archive-meta"),
      ).toHaveTextContent(
        "displaced to make room · Everywhere · archived Mar 4, 2026",
      );
      expect(
        within(rowOf("forgotten")).getByTestId("memory-archive-meta"),
      ).toHaveTextContent("retired by an agent");
      expect(
        within(rowOf("superseded")).getByTestId("memory-archive-meta"),
      ).toHaveTextContent("replaced");
    });

    it("still says which lines an agent wrote", async () => {
      const user = userEvent.setup();
      archivedStore([
        archivedEntry({
          id: "a",
          text: "An agent wrote this",
          createdBySessionId: "s-1",
        }),
        archivedEntry({ id: "b", text: "The operator wrote this" }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));

      expect(screen.getAllByTestId("memory-from-agent")).toHaveLength(1);
    });

    it("puts a line back in the list when the operator asks", async () => {
      const user = userEvent.setup();
      archivedStore([
        archivedEntry({
          id: "old",
          text: "The branch is main",
          createdAt: 10,
          createdBySessionId: "s-1",
        }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));
      await user.click(screen.getByTestId("memory-archive-restore"));

      const state = useMemoryStore.getState();
      expect(state.archived).toHaveLength(0);
      // As itself: same id, same date, same provenance.
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]).toMatchObject({
        id: "old",
        text: "The branch is main",
        createdAt: 10,
        createdBySessionId: "s-1",
      });
      expect(
        screen.getByRole("textbox", { name: "Edit this memory" }),
      ).toHaveValue("The branch is main");
    });

    it("destroys a line for good only once the operator confirms", async () => {
      const user = userEvent.setup();
      archivedStore([
        archivedEntry({ id: "doomed", text: "My home address" }),
        archivedEntry({ id: "keeper", text: "Something harmless" }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));
      const row = document.querySelector('[data-archived-id="doomed"]');
      await user.click(
        within(row as HTMLElement).getByRole("button", {
          name: "Delete forever",
        }),
      );

      // The trash button alone destroys nothing.
      expect(useMemoryStore.getState().archived).toHaveLength(2);
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("My home address");

      await user.click(
        within(dialog).getByRole("button", { name: "Delete forever" }),
      );

      await waitFor(() => {
        expect(useMemoryStore.getState().archived.map((e) => e.id)).toEqual([
          "keeper",
        ]);
      });
    });

    it("scrolls to what replaced a corrected line, opening its area on the way", async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.fn();
      const original = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
      try {
        // Sixteen live memories, so the area holding the replacement is folded
        // away: a link that scrolls to an unmounted row goes nowhere.
        useMemoryStore.setState({
          entries: Array.from({ length: 16 }, (_, index) =>
            entry({
              id: `e-${index}`,
              text: `Fact number ${index}`,
              createdAt: index,
            }),
          ),
          archived: [
            archivedEntry({
              id: "old",
              text: "The branch is main",
              archiveReason: "superseded",
              replacedById: "e-3",
            }),
          ],
          appliedMessageIds: [],
        });
        renderWithProviders(<MemorySettings />);

        expect(screen.getByTestId("memory-group-toggle")).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await user.click(screen.getByTestId("memory-archive-toggle"));
        await user.click(screen.getByTestId("memory-archive-replacement"));

        expect(screen.getByTestId("memory-group-toggle")).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        expect(scrollIntoView).toHaveBeenCalled();
      } finally {
        HTMLElement.prototype.scrollIntoView = original;
      }
    });

    it("offers no way to a replacement that is no longer there", async () => {
      const user = userEvent.setup();
      archivedStore([
        archivedEntry({
          id: "old",
          text: "The branch is main",
          archiveReason: "superseded",
          replacedById: "gone",
        }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));

      expect(screen.queryByTestId("memory-archive-replacement")).toBeNull();
    });

    it("finds archived lines in the search and marks them as archived", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({
        entries: [entry({ id: "live", text: "The branch is release/2026.10" })],
        archived: [
          archivedEntry({ id: "old", text: "The branch is release/2026.9" }),
        ],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      await user.type(screen.getByTestId("memory-search-input"), "branch");

      const results = screen.getAllByTestId("memory-search-result");
      expect(results).toHaveLength(2);
      // The live one first, and only the archived one carries the badge.
      expect(results[0]).toHaveAttribute("data-archived", "false");
      expect(
        within(results[0]).queryByTestId("memory-search-archived"),
      ).toBeNull();
      expect(results[1]).toHaveAttribute("data-archived", "true");
      expect(
        within(results[1]).getByTestId("memory-search-archived"),
      ).toHaveTextContent("in the archive");
    });

    it("sweeps a dead project's archive along with its live rows", async () => {
      const user = userEvent.setup();
      useProjectStore.setState({
        projects: [project("p-live", "Still here")],
        hasFetchedProjects: true,
      });
      useMemoryStore.setState({
        entries: [
          entry({
            id: "dead",
            text: "A dead project fact",
            scope: "project",
            projectId: "p-gone",
          }),
        ],
        archived: [
          archivedEntry({
            id: "dead-old",
            text: "An older dead project fact",
            scope: "project",
            projectId: "p-gone",
          }),
          archivedEntry({ id: "g-old", text: "An older global fact" }),
        ],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      // One button, on the live card: the archive does not offer a second one
      // for a project that still has a card of its own.
      const sweep = screen.getAllByTestId("memory-forget-project");
      expect(sweep).toHaveLength(1);
      await user.click(sweep[0]);
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: "Forget them" }),
      );

      await waitFor(() => {
        expect(useMemoryStore.getState().entries).toHaveLength(0);
      });
      // The half the panel could not see before is gone too (G2/F4).
      expect(useMemoryStore.getState().archived.map((e) => e.id)).toEqual([
        "g-old",
      ]);
    });

    it("offers the sweep here when a dead project's only trace is archived", async () => {
      const user = userEvent.setup();
      useProjectStore.setState({
        projects: [project("p-live", "Still here")],
        hasFetchedProjects: true,
      });
      archivedStore([
        archivedEntry({
          id: "dead-old",
          text: "All that is left of a deleted project",
          scope: "project",
          projectId: "p-gone",
        }),
      ]);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-archive-toggle"));
      const sweep = screen.getAllByTestId("memory-forget-project");
      expect(sweep).toHaveLength(1);

      await user.click(sweep[0]);
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: "Forget them" }),
      );

      await waitFor(() => {
        expect(useMemoryStore.getState().archived).toHaveLength(0);
      });
    });
  });

  describe("deleting a line that replaced earlier wordings", () => {
    it("counts them in the question and takes them with it", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({
        entries: [entry({ id: "live", text: "The branch is release/2026.10" })],
        archived: [
          archivedEntry({
            id: "second",
            text: "The branch is release/2026.9",
            archiveReason: "superseded",
            replacedById: "live",
          }),
          archivedEntry({
            id: "first",
            text: "The branch is main",
            archiveReason: "superseded",
            replacedById: "second",
          }),
        ],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByRole("button", { name: "Forget this" }));
      const dialog = await screen.findByRole("dialog");
      // The cascade is stated rather than silent: "this cannot be undone" has
      // to cover everything the click actually removes (G2/F3).
      expect(dialog).toHaveTextContent(
        "Its 2 earlier wordings, kept in the archive, go with it.",
      );

      await user.click(
        within(dialog).getByRole("button", { name: "Forget this" }),
      );

      await waitFor(() => {
        expect(useMemoryStore.getState().entries).toHaveLength(0);
      });
      expect(useMemoryStore.getState().archived).toHaveLength(0);
    });

    it("asks the plain question when nothing in the archive hangs off it", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({
        entries: [entry({ id: "live", text: "A fact with no history" })],
        archived: [
          archivedEntry({ id: "unrelated", text: "Something else entirely" }),
        ],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByRole("button", { name: "Forget this" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).not.toHaveTextContent("earlier wording");

      await user.click(
        within(dialog).getByRole("button", { name: "Forget this" }),
      );

      await waitFor(() => {
        expect(useMemoryStore.getState().entries).toHaveLength(0);
      });
      expect(useMemoryStore.getState().archived.map((e) => e.id)).toEqual([
        "unrelated",
      ]);
    });
  });
  describe("the review", () => {
    it("has nothing to review while nothing is kept", () => {
      renderWithProviders(<MemorySettings />);
      expect(screen.getByTestId("memory-review-run")).toBeDisabled();
    });

    it("opens a projectless chat carrying the whole record", async () => {
      const user = userEvent.setup();
      useProjectStore.setState({
        projects: [project("p-1", "Distill Code")],
        hasFetchedProjects: true,
      });
      useMemoryStore.setState({
        entries: [
          entry({ id: "g", text: "Ivan reviews Rust himself" }),
          entry({
            id: "p",
            text: "The release branch is release/2026.9",
            scope: "project",
            projectId: "p-1",
          }),
        ],
        archived: [archivedEntry({ id: "old", text: "A retired fact" })],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-review-run"));

      await waitFor(() => {
        expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2);
      });
      const [name, rawArgs] = mocks.dispatchCommand.mock.calls[0];
      const args = rawArgs as {
        action: string;
        prompt: string;
        project_id?: string;
      };
      expect(name).toBe("sessions");
      expect(args.action).toBe("create");
      // No project on the chat: a review ranges over every area, and a chat
      // inside one project would only ever be shown that project's memories.
      expect(args.project_id).toBeUndefined();
      expect(args.prompt).toContain("Ivan reviews Rust himself");
      expect(args.prompt).toContain("The release branch is release/2026.9");
      expect(args.prompt).toContain("## Everywhere");
      expect(args.prompt).toContain("## Distill Code");
      expect(args.prompt).toContain("1 memory is archived");
      expect(args.prompt).toContain("Apply nothing yet");
      // And then the operator is taken to it — a review chat they have to go
      // find is a review that does not happen.
      expect(mocks.dispatchCommand).toHaveBeenLastCalledWith(
        "sessions",
        { action: "open", session_id: "review-1" },
        {},
      );
    });

    it("says so when the chat could not be opened", async () => {
      const user = userEvent.setup();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mocks.dispatchCommand.mockRejectedValue(new Error("no backend"));
      useMemoryStore.setState({
        entries: [entry({ id: "g", text: "Ivan reviews Rust himself" })],
        appliedMessageIds: [],
      });
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-review-run"));

      expect(
        await screen.findByTestId("memory-review-failed"),
      ).toBeInTheDocument();
      // Still clickable: the failure was the backend's, and the operator has
      // no other way to start the pass.
      expect(screen.getByTestId("memory-review-run")).not.toBeDisabled();
      consoleError.mockRestore();
    });
  });

  describe("importing a memory file", () => {
    const CLAUDE_MD = [
      "# Project memory",
      "",
      "## Conventions",
      "",
      "- Ivan reviews every Rust change himself",
      "- The release branch is release/2026.9",
      "- Never push straight to main",
      "- The CI token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "",
      "```bash",
      "just test",
      "```",
    ].join("\n");

    function offerFile(contents: string, truncated = false) {
      mocks.openFileDialog.mockResolvedValue("/home/ivan/repo/CLAUDE.md");
      mocks.readTextFile.mockResolvedValue({
        contents,
        byteSize: contents.length,
        truncated,
      });
    }

    /** Opens the picker and waits for the candidate list it produces. */
    async function openImportDialog(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByTestId("memory-import-open"));
      return await screen.findByTestId("memory-import-dialog");
    }

    it("offers the file's bullets and keeps its scaffolding out", async () => {
      const user = userEvent.setup();
      offerFile(CLAUDE_MD);
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);

      const candidates = within(dialog).getAllByTestId(
        "memory-import-candidate",
      );
      expect(candidates.map((row) => row.textContent)).toEqual([
        "Ivan reviews every Rust change himself",
        "The release branch is release/2026.9",
        "Never push straight to main",
      ]);
      // A heading is a title and a fenced block is a snippet; neither is a
      // fact anyone asked to carry into every later prompt.
      expect(dialog).not.toHaveTextContent("Project memory");
      expect(dialog).not.toHaveTextContent("just test");
    });

    it("never shows a line that carries a token, only how many there were", async () => {
      const user = userEvent.setup();
      offerFile(CLAUDE_MD);
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);

      expect(dialog).not.toHaveTextContent("ghp_");
      expect(
        within(dialog).getByTestId("memory-import-secrets"),
      ).toHaveTextContent(
        "1 line is not listed: it looks like it carries a key, a token or a password.",
      );
    });

    it("keeps the two ticked lines as the operator's own", async () => {
      const user = userEvent.setup();
      offerFile(CLAUDE_MD);
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Ivan reviews every Rust change himself",
        }),
      );
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Never push straight to main",
        }),
      );
      await user.click(within(dialog).getByTestId("memory-import-confirm"));

      await waitFor(() => {
        expect(useMemoryStore.getState().entries).toHaveLength(2);
      });
      const entries = useMemoryStore.getState().entries;
      expect(entries.map((item) => item.text)).toEqual([
        "Ivan reviews every Rust change himself",
        "Never push straight to main",
      ]);
      // The provenance that matters: these came from a file the operator
      // chose and ticked line by line, so no session wrote them and the panel
      // must not badge them as an agent's.
      for (const item of entries) {
        expect(item.createdBySessionId).toBeUndefined();
        expect(item.scope).toBe("global");
      }
      expect(screen.queryAllByTestId("memory-from-agent")).toHaveLength(0);
      // And nothing that was left unticked was kept.
      expect(entries.map((item) => item.text)).not.toContain(
        "The release branch is release/2026.9",
      );
    });

    it("keeps ticked lines inside the chosen project", async () => {
      const user = userEvent.setup();
      useProjectStore.setState({ projects: [project("p-1", "Distill Code")] });
      offerFile("- Deploys go out on Tuesdays");
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);
      await user.click(within(dialog).getByTestId("memory-import-select-all"));
      await user.selectOptions(
        within(dialog).getByTestId("memory-import-scope"),
        within(dialog).getByRole("option", { name: "Distill Code" }),
      );
      await user.click(within(dialog).getByTestId("memory-import-confirm"));

      await waitFor(() => {
        expect(useMemoryStore.getState().entries).toHaveLength(1);
      });
      expect(useMemoryStore.getState().entries[0]).toMatchObject({
        text: "Deploys go out on Tuesdays",
        scope: "project",
        projectId: "p-1",
      });
    });

    it("counts what was already remembered rather than claiming it kept it", async () => {
      const user = userEvent.setup();
      useMemoryStore.setState({
        entries: [entry({ id: "known", text: "Never push straight to main" })],
        archived: [],
        appliedMessageIds: [],
      });
      offerFile(
        ["- Never push straight to main", "- Tags are signed"].join("\n"),
      );
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);
      await user.click(within(dialog).getByTestId("memory-import-select-all"));
      await user.click(within(dialog).getByTestId("memory-import-confirm"));

      expect(
        await screen.findByTestId("memory-import-result"),
      ).toHaveTextContent("Kept 1 of 2: 1 already remembered, 0 not kept.");
      expect(useMemoryStore.getState().entries).toHaveLength(2);
    });

    it("writes nothing while the operator has ticked nothing", async () => {
      const user = userEvent.setup();
      offerFile(CLAUDE_MD);
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);

      // Nothing is ticked to begin with: a memory travels into every later
      // prompt, so the operator says yes rather than failing to say no.
      expect(
        within(dialog).getByTestId("memory-import-confirm"),
      ).toBeDisabled();
      expect(useMemoryStore.getState().entries).toHaveLength(0);
    });

    it("says so when the file holds nothing that reads like a memory", async () => {
      const user = userEvent.setup();
      offerFile(["# Notes", "", "```", "cargo build", "```"].join("\n"));
      renderWithProviders(<MemorySettings />);

      const dialog = await openImportDialog(user);

      expect(
        within(dialog).getByTestId("memory-import-empty"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByTestId("memory-import-confirm"),
      ).toBeDisabled();
    });

    it("says so when the file could not be read", async () => {
      const user = userEvent.setup();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mocks.openFileDialog.mockResolvedValue("/home/ivan/repo/CLAUDE.md");
      mocks.readTextFile.mockRejectedValue(new Error("no such file"));
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-import-open"));

      expect(
        await screen.findByTestId("memory-import-failed"),
      ).toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("treats a cancelled picker as nothing having happened", async () => {
      const user = userEvent.setup();
      mocks.openFileDialog.mockResolvedValue(null);
      renderWithProviders(<MemorySettings />);

      await user.click(screen.getByTestId("memory-import-open"));

      await waitFor(() => {
        expect(mocks.openFileDialog).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByTestId("memory-import-dialog")).toBeNull();
      expect(screen.queryByTestId("memory-import-failed")).toBeNull();
    });
  });
});
