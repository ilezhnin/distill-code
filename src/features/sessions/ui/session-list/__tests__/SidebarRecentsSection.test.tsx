import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarChatDragProvider } from "../SidebarChatDragContext";
import type { SidebarSessionItem } from "../SidebarProjectSection";
import { SidebarRecentsSection } from "../SidebarRecentsSection";

const sessions = [
  {
    id: "pinned-chat",
    title: "Pinned Chat",
    updatedAt: "2026-04-09T12:00:00.000Z",
  },
  {
    id: "regular-chat",
    title: "Regular Chat",
    updatedAt: "2026-04-09T11:00:00.000Z",
  },
];

function renderRecents(
  showChatIcons: boolean,
  sessionOverrides: Partial<SidebarSessionItem> = {},
  collapsed = false,
  props: Partial<ComponentProps<typeof SidebarRecentsSection>> = {},
) {
  return render(
    <SidebarChatDragProvider>
      <SidebarRecentsSection
        sessions={sessions.map((session) => ({
          ...session,
          ...(session.id === "regular-chat" ? sessionOverrides : {}),
        }))}
        collapsed={collapsed}
        labelTransition=""
        labelVisible
        showChatIcons={showChatIcons}
        onShowChatIconsChange={vi.fn()}
        showTimestamps
        onShowTimestampsChange={vi.fn()}
        isOpen
        onToggleOpen={vi.fn()}
        sectionHeaderTextClass=""
        {...props}
      />
    </SidebarChatDragProvider>,
  );
}

describe("SidebarRecentsSection", () => {
  it("renders an empty chat section as a non-collapsible label", () => {
    const onToggleOpen = vi.fn();
    renderRecents(false, {}, false, {
      sessions: [],
      showEmptyState: true,
      isOpen: false,
      onToggleOpen,
      onNewChat: vi.fn(),
    });

    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Chats" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a chat" })).toBeVisible();
    expect(onToggleOpen).not.toHaveBeenCalled();
  });

  it("keeps collapsed recent chat icons accessibly named", () => {
    renderRecents(true, {}, true);

    expect(
      screen.getByRole("button", { name: "Regular Chat" }),
    ).toBeInTheDocument();
  });

  it("shows the chat glyph but no quick-pin control when general chat icons are shown", async () => {
    const user = userEvent.setup();
    const { container } = renderRecents(true);
    const regularRow = container.querySelector<HTMLElement>(
      '[data-session-id="regular-chat"]',
    );
    if (!regularRow) throw new Error("Regular chat row was not rendered");

    expect(
      within(regularRow).getByTestId("sidebar-chat-menu-icon"),
    ).toBeInTheDocument();
    // Pin-to-Home is gone from the product: the leading slot is the chat
    // glyph only, and no pin control may ever appear on a row.
    await user.hover(regularRow);
    expect(screen.queryByRole("button", { name: "Pin chat" })).toBeNull();
  });

  it("hides general chat icons and hover pinning when icons are off", async () => {
    const user = userEvent.setup();
    const { container } = renderRecents(false);
    const regularRow = container.querySelector<HTMLElement>(
      '[data-session-id="regular-chat"]',
    );
    if (!regularRow) throw new Error("Regular chat row was not rendered");

    expect(
      within(regularRow).queryByTestId("sidebar-chat-menu-icon"),
    ).toBeNull();
    await user.hover(regularRow);
    expect(screen.queryByRole("button", { name: "Pin chat" })).toBeNull();
    // No unpin control either — the pin feature no longer exists.
    expect(screen.queryByRole("button", { name: "Unpin chat" })).toBeNull();
  });

  it.each([
    { state: { isRunning: true }, label: /chat active/i },
    { state: { hasUnread: true }, label: /unread messages/i },
  ])("shows $label when chat icons are hidden", ({ state, label }) => {
    const { container } = renderRecents(false, state);
    const regularRow = container.querySelector<HTMLElement>(
      '[data-session-id="regular-chat"]',
    );
    if (!regularRow) throw new Error("Regular chat row was not rendered");

    expect(within(regularRow).getByLabelText(label)).toBeInTheDocument();
  });
});
