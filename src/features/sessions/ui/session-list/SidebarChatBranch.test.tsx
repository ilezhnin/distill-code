import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function guideShapes(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll("[data-slot=tree-guide]")).map(
    (guide) =>
      `${guide.getAttribute("data-shape")}@${(guide as HTMLElement).style.left}`,
  );
}

function renderProject(onSelectSession?: (sessionId: string) => void) {
  render(
    <SidebarProjectSection
      project={project}
      projectChats={[conductor, plain]}
      isExpanded
      toggleProject={vi.fn()}
      showChatIcons={false}
      onSelectSession={onSelectSession}
    />,
  );
}

beforeEach(() => {
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY);
  resetCollapsedChatTreesForTests();
  useProjectStore.setState({ projects: [project] });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: [] });
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

  it("indents a parent to its children's column and draws one line down to the last child", () => {
    renderProject();
    // A chat with children moves one column right, so its icon heads the
    // line and its title lines up with its children's titles.
    expect(rowOf("conductor").style.paddingLeft).toBe("16px");
    expect(rowOf("orchestrator").style.paddingLeft).toBe("32px");
    expect(rowOf("worker").style.paddingLeft).toBe("32px");
    expect(rowOf("reviewer").style.paddingLeft).toBe("16px");
    expect(rowOf("plain").style.paddingLeft).toBe("");
    // The line starts under the parent's icon, passes the children that
    // have siblings after them, and closes with an elbow on the last one —
    // through a grandchild's row too, so it never breaks.
    expect(guideShapes(rowOf("conductor"))).toEqual(["stub@28px"]);
    expect(guideShapes(rowOf("orchestrator"))).toEqual([
      "pass@28px",
      "stub@44px",
    ]);
    expect(guideShapes(rowOf("worker"))).toEqual(["pass@28px", "last@44px"]);
    expect(guideShapes(rowOf("reviewer"))).toEqual(["last@28px"]);
    expect(guideShapes(rowOf("plain"))).toEqual([]);
  });

  it("keeps a parent's icon in its slot and puts the fold chevron after its name", async () => {
    const user = userEvent.setup();
    renderProject();
    // The icon is the row's identity and stays put, hover or not; the
    // chevron sits inside the row button after the title, and a leaf chat
    // has neither.
    expect(leadingIconOf("conductor")).not.toBeNull();
    expect(leadingIconOf("plain")).toBeNull();
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
    // A folded parent keeps its column but draws no line below its icon.
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

  it("opens an agent's chat from its row without touching the fold, and shifts nothing in Recents", async () => {
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
    // Recents reserves no leading slot, so the parent stays where its
    // neighbours are: its icon takes the slot and the line hangs from it.
    expect(rowOf("conductor").style.paddingLeft).toBe("");
    expect(rowOf("orchestrator").style.paddingLeft).toBe("16px");
    expect(rowOf("worker").style.paddingLeft).toBe("16px");
    expect(rowOf("reviewer").style.paddingLeft).toBe("");
    expect(guideShapes(rowOf("conductor"))).toEqual(["stub@12px"]);
    expect(guideShapes(rowOf("orchestrator"))).toEqual([
      "pass@12px",
      "stub@28px",
    ]);
    expect(guideShapes(rowOf("worker"))).toEqual(["pass@12px", "last@28px"]);
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
