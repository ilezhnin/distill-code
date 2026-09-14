import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChildChatTabsStore } from "../../stores/childChatTabsStore";
import { ChildChatPanel } from "../ChildChatPanel";

const mocks = vi.hoisted(() => ({
  gateSpy: vi.fn(),
  classicSpy: vi.fn(),
}));

vi.mock("../VirtualMessageTimelineGate", () => ({
  VirtualMessageTimelineGate: (props: {
    sessionId: string;
    messages: Message[];
    streamingMessageId?: string | null;
    placeholder?: ReactNode;
  }) => {
    mocks.gateSpy(props);
    return <div data-testid="child-virtual-timeline">{props.sessionId}</div>;
  },
}));

// The classic timeline mounts every row, so the panel must not reach for it.
vi.mock("../MessageTimeline", () => ({
  MessageTimeline: (props: { messages: Message[] }) => {
    mocks.classicSpy(props);
    return <div data-testid="child-classic-timeline" />;
  },
}));

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages: vi.fn(() => Promise.resolve()),
}));

const HOST_SESSION_ID = "host-session";
const CHILD_SESSION_ID = "child-session";

function message(id: string): Message {
  return {
    id,
    role: id.startsWith("u") ? "user" : "assistant",
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [{ type: "text", text: id }],
    metadata: { userVisible: true },
  };
}

describe("ChildChatPanel", () => {
  beforeEach(() => {
    mocks.gateSpy.mockClear();
    mocks.classicSpy.mockClear();
    useChildChatTabsStore.setState({
      tabsBySession: {},
      activeChildIdBySession: {},
      openBySession: {},
    });
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      loadingSessionIds: new Set<string>(),
    });
  });

  it("renders the child transcript through the windowed timeline, not the classic one", () => {
    const childMessages = Array.from({ length: 40 }, (_, index) =>
      message(index % 2 === 0 ? `u-${index}` : `a-${index}`),
    );
    useChatStore.setState({
      messagesBySession: { [CHILD_SESSION_ID]: childMessages },
      sessionStateById: {
        [CHILD_SESSION_ID]: {
          streamingMessageId: "a-39",
        },
      } as never,
    });
    useChildChatTabsStore
      .getState()
      .open(HOST_SESSION_ID, { sessionId: CHILD_SESSION_ID, name: "worker" });

    render(<ChildChatPanel hostSessionId={HOST_SESSION_ID} />);

    expect(screen.getByTestId("child-virtual-timeline")).toBeInTheDocument();
    expect(
      screen.queryByTestId("child-classic-timeline"),
    ).not.toBeInTheDocument();
    expect(mocks.classicSpy).not.toHaveBeenCalled();
    // The gate needs the *child's* session id: that is what gives the panel its
    // own loaded transcript and projection cache instead of the host's.
    expect(mocks.gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: CHILD_SESSION_ID,
        messages: childMessages,
        streamingMessageId: "a-39",
      }),
    );
  });

  it("keeps showing the placeholder for a child whose transcript is empty", () => {
    useChildChatTabsStore
      .getState()
      .open(HOST_SESSION_ID, { sessionId: CHILD_SESSION_ID, name: "worker" });

    render(<ChildChatPanel hostSessionId={HOST_SESSION_ID} />);

    expect(mocks.gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: CHILD_SESSION_ID, messages: [] }),
    );
    expect(mocks.gateSpy.mock.lastCall?.[0].showPlaceholder).toBe(true);
  });
});
