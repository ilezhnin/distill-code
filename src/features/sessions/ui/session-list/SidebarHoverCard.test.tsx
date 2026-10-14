import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  SidebarProjectSection,
  type SidebarSessionItem,
} from "./SidebarProjectSection";
import { SidebarChatRow } from "./SidebarChatRow";

const project: ProjectInfo = {
  id: "sample-project",
  path: "C:/Example/.distill/project.json",
  name: "Sample project",
  description: "",
  prompt: "",
  icon: "",
  color: "blue",
  projectWorkspaces: [],
  workingDirs: ["C:/Example/Workspace", "C:/Example/Assets"],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};
const chats: SidebarSessionItem[] = Array.from({ length: 7 }, (_, index) => ({
  id: `chat-${index}`,
  title: `A long conversation title ${index}`,
  updatedAt: "2026-01-01T00:00:00Z",
  activityAt: "2026-01-01T00:00:00Z",
  isRunning: index === 0,
}));

function renderProject(
  overrides: Partial<Parameters<typeof SidebarProjectSection>[0]> = {},
) {
  const onEditProject = vi.fn();
  const toggleProject = vi.fn();
  render(
    <SidebarProjectSection
      project={project}
      projectChats={chats}
      isExpanded={false}
      toggleProject={toggleProject}
      onEditProject={onEditProject}
      showChatIcons={false}
      {...overrides}
    />,
  );
  return {
    onEditProject,
    toggleProject,
    trigger: screen.getByRole("button", { name: project.name }),
  };
}

beforeEach(() => useProjectStore.setState({ projects: [project] }));
afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: [] });
});

describe("sidebar hover previews", () => {
  it("shows all loaded chats and workspace folders, and edits without toggling the project", async () => {
    const user = userEvent.setup();
    const { trigger, onEditProject, toggleProject } = renderProject();
    await user.hover(trigger);
    const card = await screen.findByRole("dialog", { name: project.name });
    expect(within(card).getByText("7 chats · 1 active")).toBeVisible();
    for (const path of project.workingDirs)
      expect(within(card).getByText(path)).toBeVisible();
    await user.hover(card);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(card).toBeVisible();
    await user.click(
      within(card).getByRole("button", { name: "Edit Project" }),
    );
    expect(onEditProject).toHaveBeenCalledWith(project.id);
    expect(toggleProject).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("does not flash previews when moving quickly across rows", async () => {
    const user = userEvent.setup();
    const { trigger } = renderProject();
    await user.hover(trigger);
    await user.unhover(trigger);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("supports keyboard access and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const { trigger } = renderProject();
    trigger.focus();
    await user.keyboard("{ArrowRight}");
    const card = await screen.findByRole("dialog", { name: project.name });
    expect(
      within(card).getByRole("button", { name: "Edit Project" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("marks incomplete totals and handles a project without chats or folders", async () => {
    const user = userEvent.setup();
    const { trigger } = renderProject({
      project: { ...project, workingDirs: [] },
      projectChats: [],
      hasMoreSessions: true,
    });
    await user.hover(trigger);
    const card = await screen.findByRole("dialog");
    expect(within(card).getByText("0+ chats")).toBeVisible();
    expect(within(card).queryByText(project.path)).not.toBeInTheDocument();
  });

  it("shows a chat's full title, project and activity even with row timestamps hidden", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SidebarChatRow
        id="chat-0"
        title={chats[0].title}
        activityAt={chats[0].activityAt}
        currentProjectId={project.id}
        isActive={false}
        onSelect={onSelect}
      />,
    );
    const trigger = screen.getByRole("button", { name: chats[0].title });
    await user.hover(trigger);
    const card = await screen.findByRole("dialog", { name: chats[0].title });
    expect(within(card).getByText(project.name)).toBeVisible();
    expect(card.querySelector("time")).toHaveAttribute(
      "dateTime",
      chats[0].activityAt,
    );
    await user.click(trigger);
    expect(onSelect).toHaveBeenCalledWith("chat-0");
  });

  it("keeps the context menu and double-click rename reachable", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <SidebarChatRow
        id="standalone"
        title="Original title"
        isActive={false}
        onRename={onRename}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Original title" });
    await user.hover(trigger);
    const card = await screen.findByRole("dialog");
    expect(within(card).getByText("No project")).toBeVisible();
    fireEvent.contextMenu(trigger);
    expect(await screen.findByRole("menu")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.keyboard("{Escape}");
    await user.dblClick(trigger);
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Updated title{Enter}");
    expect(onRename).toHaveBeenCalledWith("standalone", "Updated title");
  });
});
