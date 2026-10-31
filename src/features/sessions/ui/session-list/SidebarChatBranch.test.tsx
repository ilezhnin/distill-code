import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY,
  resetCollapsedChatTreesForTests,
  setChatTreeCollapsed,
} from "@/features/sidebar/lib/sidebarChatTreeCollapse";

import { SidebarChatBranch } from "./SidebarChatBranch";
import {
  SidebarProjectSection,
  type SidebarSessionItem,
} from "./SidebarProjectSection";
import { SidebarRecentsSection } from "./SidebarRecentsSection";

const project: ProjectInfo = {
  id: "sample-project",
  path: "C:/Example/.distill/project.json",
  name: "Sample project",
  description: "",
  prompt: "",
  icon: "",
  color: "blue",
  projectWorkspaces: [],
  workingDirs: [],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

function chat(
  id: string,
  title: string,
  extra: Partial<SidebarSessionItem> = {},
): SidebarSessionItem {
  return {
    id,
    title,
    updatedAt: "2026-01-01T00:00:00Z",
    activityAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

const conductor = chat("conductor", "Upstream review", {
  children: [
    chat("orchestrator", "Atlas", {
      isRunning: true,
      children: [chat("worker", "Researcher · berd since fork")],
    }),
    chat("reviewer", "Reviewer"),
  ],
});
const plain = chat("plain", "Backup the Flock folder");

function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-sidebar-chat-row][data-session-id]"),
  ).flatMap((row) => {
    const id = row.getAttribute("data-session-id");
    return id ? [id] : [];
  });
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector(
    `[data-sidebar-chat-row][data-session-id="${id}"]`,
  );
  if (!(row instanceof HTMLElement)) throw new Error(`no row ${id}`);
  return row;
}

function rowButtonOf(id: string, title: string): HTMLElement {
  return within(rowOf(id)).getByRole("button", { name: title });
}

function toggleOf(id: string): HTMLElement {
  const toggle = rowOf(id).querySelector("[data-sidebar-chat-tree-toggle]");
  if (!(toggle instanceof HTMLElement)) throw new Error(`no toggle ${id}`);
  return toggle;
}

function leadingIconOf(id: string): Element | null {
  return rowOf(id).querySelector("[data-testid=sidebar-chat-menu-icon]");
}

/** Where a row's name starts: the inset its button carries. */
function nameInsetOf(id: string): string {
  const button = rowOf(id).querySelector("[data-sidebar-chat-row-button]");
  if (!(button instanceof HTMLElement)) throw new Error(`no button ${id}`);
  return button.style.paddingLeft;
}

/** Where a row's icon starts, or null when the row shows none. */
function iconInsetOf(id: string): string | null {
  const icon = rowOf(id).querySelector(
    "[data-testid=sidebar-chat-menu-icon], [data-testid=sidebar-conductor-icon]",
  );
  const slot = icon?.closest("span[style]");
  return slot instanceof HTMLElement ? slot.style.left : null;
}

function guideShapes(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll("[data-slot=tree-guide]")).map(
    (guide) =>
      `${guide.getAttribute("data-shape")}@${(guide as HTMLElement).style.left}`,
  );
}

function renderProject(
  onSelectSession?: (sessionId: string) => void,
  showChatIcons = false,
  projectChats = [conductor, plain],
) {
  render(
    <SidebarProjectSection
      project={project}
      projectChats={projectChats}
      isExpanded
      toggleProject={vi.fn()}
      showChatIcons={showChatIcons}
      onSelectSession={onSelectSession}
    />,
  );
}

function markConductor(sessionId: string) {
  useConductorGraphStore.setState({
    nodesById: {
      [sessionId]: {
        sessionId,
        projectId: project.id,
        role: "conductor",
        managedBy: "ui",
        parentSessionId: null,
        rootConductorId: null,
        runId: null,
        harnessId: "claude",
        displayName: "Conductor",
        status: "waiting",
      } satisfies SessionNode,
    },
  });
}

beforeEach(() => {
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY);
  resetCollapsedChatTreesForTests();
  useProjectStore.setState({ projects: [project] });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: [] });
  useConductorGraphStore.setState({ nodesById: {} });
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY);
  resetCollapsedChatTreesForTests();
});

describe("chats nested under the chat that started them", () => {
  it("lists a project's agents under their chat, in tree order, at every depth", () => {
    renderProject();
    expect(rowIds()).toEqual([
      "conductor",
      "orchestrator",
      "worker",
      "reviewer",
      "plain",
    ]);
    expect(rowOf("conductor").dataset.sidebarChatTreeDepth).toBeUndefined();
    expect(rowOf("orchestrator").dataset.sidebarChatTreeDepth).toBe("1");
    expect(rowOf("worker").dataset.sidebarChatTreeDepth).toBe("2");
    // The one that is working says so on its own row, like any other chat.
    expect(
      within(rowOf("orchestrator")).getByRole("status", {
        name: "Chat active",
      }),
    ).toBeInTheDocument();
  });

  it("puts a project's chats one level in and each chat's agents one level below it", () => {
    renderProject();
    // One step per level: the project's chats start where the project's
    // name does (12 + 24), their agents one step further in. A chat with
    // agents stays on its siblings' level.
    expect(nameInsetOf("conductor")).toBe("36px");
    expect(nameInsetOf("orchestrator")).toBe("60px");
    expect(nameInsetOf("worker")).toBe("84px");
    expect(nameInsetOf("reviewer")).toBe("60px");
    expect(nameInsetOf("plain")).toBe("36px");
    // The line starts under the parent, passes the children that have
    // siblings after them, and closes with an elbow on the last one —
    // through a grandchild's row too, so it never breaks.
    expect(guideShapes(rowOf("conductor"))).toEqual(["stub@36px"]);
    expect(guideShapes(rowOf("orchestrator"))).toEqual([
      "pass@36px",
      "stub@60px",
    ]);
    expect(guideShapes(rowOf("worker"))).toEqual(["pass@36px", "last@60px"]);
    expect(guideShapes(rowOf("reviewer"))).toEqual(["last@36px"]);
    expect(guideShapes(rowOf("plain"))).toEqual([]);
  });

  it("lines a conductor and a chat with agents up with the plain chats beside them", () => {
    markConductor("lead");
    const lead = chat("lead", "Migration plan");
    renderProject(undefined, false, [lead, conductor, plain]);
    // Without chat icons no row has one, a conductor's or a parent's
    // included, so every name in the project starts on one line.
    expect(iconInsetOf("lead")).toBeNull();
    expect(iconInsetOf("conductor")).toBeNull();
    expect(nameInsetOf("lead")).toBe("36px");
    expect(nameInsetOf("conductor")).toBe("36px");
    expect(nameInsetOf("plain")).toBe("36px");
    cleanup();

    renderProject(undefined, true, [lead, conductor, plain]);
    // With them every row has one, one level in from the project's icon:
    // under the project's name, never beside the project's own icon.
    expect(
      rowOf("lead").querySelector("[data-testid=sidebar-conductor-icon]"),
    ).not.toBeNull();
    for (const id of ["lead", "conductor", "plain"]) {
      expect(iconInsetOf(id)).toBe("36px");
      expect(nameInsetOf(id)).toBe("60px");
    }
    expect(iconInsetOf("orchestrator")).toBe("60px");
    expect(nameInsetOf("orchestrator")).toBe("84px");
    expect(iconInsetOf("reviewer")).toBe("60px");
    expect(nameInsetOf("reviewer")).toBe("84px");
  });

  it("puts the fold chevron after a parent's name and keeps its icon put", async () => {
    const user = userEvent.setup();
    renderProject(undefined, true);
    // The icon is the row's identity and stays put, hover or not; the
    // chevron sits inside the row button after the title, and a leaf chat
    // has none.
    expect(leadingIconOf("conductor")).not.toBeNull();
    expect(leadingIconOf("plain")).not.toBeNull();
    const button = rowButtonOf("conductor", "Upstream review");
    expect(button).toHaveAttribute("aria-expanded", "true");
    const toggle = toggleOf("conductor");
    expect(button.contains(toggle)).toBe(true);
    expect(toggle).toHaveAttribute(
      "title",
      "Hide the chats Upstream review started",
    );
    expect(
      rowOf("plain").querySelector("[data-sidebar-chat-tree-toggle]"),
    ).toBeNull();
    expect(rowButtonOf("plain", "Backup the Flock folder")).not.toHaveAttribute(
      "aria-expanded",
    );
    await user.hover(button);
    expect(leadingIconOf("conductor")).not.toBeNull();
  });

  it("folds and unfolds a chat's agents from the chevron, and remembers the fold", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderProject(onSelect);
    await user.click(toggleOf("conductor"));
    // Folding is not opening.
    expect(onSelect).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(["conductor", "plain"]);
    expect(rowButtonOf("conductor", "Upstream review")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(toggleOf("conductor")).toHaveAttribute(
      "title",
      "Show the chats Upstream review started",
    );
    // A folded parent keeps its place but draws no line below it.
    expect(guideShapes(rowOf("conductor"))).toEqual([]);
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY) ??
          "[]",
      ),
    ).toEqual(["conductor"]);
    await user.click(toggleOf("conductor"));
    expect(rowIds()).toEqual([
      "conductor",
      "orchestrator",
      "worker",
      "reviewer",
      "plain",
    ]);
  });

  it("folds and unfolds from the keyboard on the focused row", async () => {
    const user = userEvent.setup();
    renderProject();
    rowButtonOf("conductor", "Upstream review").focus();
    await user.keyboard("{ArrowLeft}");
    expect(rowIds()).toEqual(["conductor", "plain"]);
    await user.keyboard("{ArrowLeft}");
    expect(rowIds()).toEqual(["conductor", "plain"]);
    await user.keyboard("{ArrowRight}");
    expect(rowIds()).toHaveLength(5);
    // A leaf ignores the keys.
    rowButtonOf("plain", "Backup the Flock folder").focus();
    await user.keyboard("{ArrowLeft}");
    expect(rowIds()).toHaveLength(5);
  });

  it("opens an agent's chat from its row without touching the fold, and starts Recents at the panel's inset", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SidebarRecentsSection
        sessions={[conductor]}
        collapsed={false}
        labelTransition=""
        labelVisible
        isOpen
        onToggleOpen={vi.fn()}
        sectionHeaderTextClass=""
        showChatIcons={false}
        onShowChatIconsChange={vi.fn()}
        onSelectSession={onSelect}
        activeSessionId="worker"
      />,
    );
    expect(rowIds()).toEqual([
      "conductor",
      "orchestrator",
      "worker",
      "reviewer",
    ]);
    // Recents is the top level: its chats start at the panel's inset and
    // the same grid takes their agents one step in per level.
    expect(nameInsetOf("conductor")).toBe("12px");
    expect(nameInsetOf("orchestrator")).toBe("36px");
    expect(nameInsetOf("worker")).toBe("60px");
    expect(nameInsetOf("reviewer")).toBe("36px");
    expect(guideShapes(rowOf("conductor"))).toEqual(["stub@12px"]);
    expect(guideShapes(rowOf("orchestrator"))).toEqual([
      "pass@12px",
      "stub@36px",
    ]);
    expect(guideShapes(rowOf("worker"))).toEqual(["pass@12px", "last@36px"]);
    expect(guideShapes(rowOf("reviewer"))).toEqual(["last@12px"]);
    await user.click(
      screen.getByRole("button", { name: "Researcher · berd since fork" }),
    );
    expect(onSelect).toHaveBeenCalledWith("worker");
    expect(rowButtonOf("conductor", "Upstream review")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("starts folded when the fold was remembered", () => {
    setChatTreeCollapsed("conductor", true);
    render(
      <SidebarChatBranch
        session={conductor}
        activeSessionId={null}
        showLeadingIcon={false}
      />,
    );
    expect(rowIds()).toEqual(["conductor"]);
    expect(rowButtonOf("conductor", "Upstream review")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
