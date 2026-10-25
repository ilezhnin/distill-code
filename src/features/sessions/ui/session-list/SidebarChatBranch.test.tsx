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

function guideShapes(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll("[data-slot=tree-guide]")).map(
    (guide) =>
      `${guide.getAttribute("data-shape")}@${(guide as HTMLElement).style.left}`,
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
    render(
      <SidebarProjectSection
        project={project}
        projectChats={[conductor, plain]}
        isExpanded
        toggleProject={vi.fn()}
        showChatIcons={false}
      />,
    );
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
    render(
      <SidebarProjectSection
        project={project}
        projectChats={[conductor, plain]}
        isExpanded
        toggleProject={vi.fn()}
        showChatIcons={false}
      />,
    );
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

  it("folds and unfolds a chat's agents from its row, and remembers the fold", async () => {
    const user = userEvent.setup();
    render(
      <SidebarProjectSection
        project={project}
        projectChats={[conductor, plain]}
        isExpanded
        toggleProject={vi.fn()}
        showChatIcons={false}
      />,
    );
    const fold = within(rowOf("conductor")).getByRole("button", {
      name: "Hide the chats Upstream review started",
    });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    await user.click(fold);
    expect(rowIds()).toEqual(["conductor", "plain"]);
    // A folded parent keeps its column but draws no line below its icon.
    expect(guideShapes(rowOf("conductor"))).toEqual([]);
    const unfold = within(rowOf("conductor")).getByRole("button", {
      name: "Show the chats Upstream review started",
    });
    expect(unfold).toHaveAttribute("aria-expanded", "false");
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSED_CHAT_TREES_STORAGE_KEY) ??
          "[]",
      ),
    ).toEqual(["conductor"]);
    await user.click(unfold);
    expect(rowIds()).toEqual([
      "conductor",
      "orchestrator",
      "worker",
      "reviewer",
      "plain",
    ]);
    // A leaf offers no fold.
    expect(
      within(rowOf("plain")).queryByRole("button", {
        name: /the chats .* started/,
      }),
    ).toBeNull();
  });

  it("opens an agent's chat from its row without touching the fold", async () => {
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
    await user.click(
      screen.getByRole("button", { name: "Researcher · berd since fork" }),
    );
    expect(onSelect).toHaveBeenCalledWith("worker");
    expect(
      within(rowOf("conductor")).getByRole("button", {
        name: "Hide the chats Upstream review started",
      }),
    ).toHaveAttribute("aria-expanded", "true");
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
  });
});
