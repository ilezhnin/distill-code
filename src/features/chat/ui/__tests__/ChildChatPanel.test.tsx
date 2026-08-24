import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import type { Message } from "@/shared/types/messages";
import { ChildChatPanel } from "../ChildChatPanel";
import { useChildChatTabsStore } from "../../stores/childChatTabsStore";

const loadSessionMessages = vi.fn().mockResolvedValue(true);

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages: (sessionId: string) => loadSessionMessages(sessionId),
}));

// The panel's contract with the timeline is "hand it this session's messages";
// rendering real bubbles would test MessageBubble, not the panel.
vi.mock("../MessageTimeline", () => ({
  MessageTimeline: ({
    messages,
    showPlaceholder,
    placeholder,
  }: {
    messages: Message[];
    showPlaceholder?: boolean;
    placeholder?: React.ReactNode;
  }) => (
    <div data-testid="child-transcript">
      {showPlaceholder
        ? placeholder
        : messages.map((message) => (
            <p key={message.id} data-testid="child-message">
              {message.content
                .map((block) => ("text" in block ? block.text : ""))
                .join("")}
            </p>
          ))}
    </div>
  ),
}));

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project-1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "host",
    rootConductorId: "host",
    runId: null,
    harnessId: "goose",
    displayName: overrides.sessionId,
    status: "running",
    ...overrides,
  };
}

function textMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    created: 0,
  } as Message;
}

function resetStores() {
  useChildChatTabsStore.setState({
    tabsBySession: {},
    activeChildIdBySession: {},
    openBySession: {},
  });
  useConductorGraphStore.setState({ nodesById: {} });
  useChatStore.setState({ messagesBySession: {} });
}

describe("ChildChatPanel", () => {
  beforeEach(() => {
    resetStores();
    loadSessionMessages.mockClear();
    useConductorGraphStore.setState({
      nodesById: {
        "child-1": node({
          sessionId: "child-1",
          displayName: "Atlas",
          status: "running",
        }),
        "child-2": node({
          sessionId: "child-2",
          displayName: "Beacon",
          status: "completed",
        }),
      },
    });
  });

  afterEach(resetStores);

  it("renders nothing until a child tab is open", () => {
    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("shows a tab per open child and the active child's transcript", () => {
    useChatStore.setState({
      messagesBySession: {
        "child-2": [textMessage("m1", "worker output")],
      },
    });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-2", name: "Beacon" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    expect(screen.getByRole("tab", { name: /Atlas/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Beacon/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("child-message")).toHaveTextContent(
      "worker output",
    );
  });

  it("hydrates a child whose transcript is not cached", () => {
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    expect(loadSessionMessages).toHaveBeenCalledWith("child-1");
  });

  it("re-hydrates a transcript the store evicted while the tab stayed open", () => {
    // `canEvictSessionMessages` treats a settled, non-streaming session as
    // evictable, and the cache holds ten — so a finished worker left open in a
    // tab is a prime candidate. Loading once on mount left the panel blank
    // forever, because `childSessionId` never changed.
    useChatStore.setState({
      messagesBySession: { "child-1": [textMessage("m1", "from Atlas")] },
    });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);
    expect(loadSessionMessages).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState({ messagesBySession: {} });
    });

    expect(loadSessionMessages).toHaveBeenCalledWith("child-1");
  });

  it("asks once for a child that genuinely has nothing to show", () => {
    // The counterpart of the re-hydration above: an empty transcript must not
    // turn the effect into a poll.
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    const { rerender } = renderWithProviders(
      <ChildChatPanel hostSessionId="host" />,
    );
    act(() => {
      useChatStore.setState({ messagesBySession: {} });
    });
    rerender(<ChildChatPanel hostSessionId="host" />);

    expect(loadSessionMessages).toHaveBeenCalledTimes(1);
  });

  it("switches transcripts when another tab is activated", async () => {
    useChatStore.setState({
      messagesBySession: {
        "child-1": [textMessage("m1", "from Atlas")],
        "child-2": [textMessage("m2", "from Beacon")],
      },
    });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-2", name: "Beacon" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);
    expect(screen.getByTestId("child-message")).toHaveTextContent(
      "from Beacon",
    );

    await userEvent.click(screen.getByRole("tab", { name: /Atlas/ }));

    expect(screen.getByTestId("child-message")).toHaveTextContent("from Atlas");
  });

  it("closing the active tab falls back to the neighbour", async () => {
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-2", name: "Beacon" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    await userEvent.click(screen.getByRole("button", { name: "Close Beacon" }));

    expect(
      screen.queryByRole("tab", { name: /Beacon/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Atlas/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows an activity pill while the child is thinking, and hides it at idle", () => {
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });
    renderWithProviders(<ChildChatPanel hostSessionId="host" />);
    // Idle: no pill — a finished worker's tab is quiet.
    expect(screen.queryByTestId("child-chat-activity")).toBeNull();

    // A synthesizing worker may produce no messages and no tool calls at all;
    // the pill is the only sign it is alive rather than hung.
    act(() => {
      useChatStore.getState().setChatState("child-1", "thinking");
    });
    expect(screen.getByTestId("child-chat-activity")).toBeInTheDocument();

    act(() => {
      useChatStore.getState().setChatState("child-1", "idle");
    });
    expect(screen.queryByTestId("child-chat-activity")).toBeNull();
  });

  it("shows the child's live run status in the strip", () => {
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);
    expect(screen.getByTestId("child-chat-tab")).toHaveAttribute(
      "data-status",
      "running",
    );

    // The graph is the single source of truth: a status change lands in the
    // strip without the panel subscribing per tab.
    act(() => {
      useConductorGraphStore.setState({
        nodesById: {
          ...useConductorGraphStore.getState().nodesById,
          "child-1": node({
            sessionId: "child-1",
            displayName: "Atlas",
            status: "completed",
          }),
        },
      });
    });

    expect(screen.getByTestId("child-chat-tab")).toHaveAttribute(
      "data-status",
      "completed",
    );
  });

  it("prefers the live graph name over the label captured at open time", () => {
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "stale name" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    expect(screen.getByRole("tab", { name: /Atlas/ })).toBeInTheDocument();
  });

  it("offers one-click full navigation for the active child", async () => {
    const onNavigateToChild = vi.fn();
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    renderWithProviders(
      <ChildChatPanel
        hostSessionId="host"
        onNavigateToChild={onNavigateToChild}
      />,
    );

    await userEvent.click(screen.getByTestId("child-chat-open-fully"));

    expect(onNavigateToChild).toHaveBeenCalledWith("child-1");
  });

  it("offers a show-chat control when the conversation is collapsed", async () => {
    const onToggleChat = vi.fn();
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    renderWithProviders(
      <ChildChatPanel
        hostSessionId="host"
        chatCollapsed
        onToggleChat={onToggleChat}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Show chat" }));

    expect(onToggleChat).toHaveBeenCalled();
  });
});
