import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorTranscript } from "@/features/conductor/ConductorTranscriptContext";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import type { Message } from "@/shared/types/messages";

import { ChildChatPanel } from "../ChildChatPanel";
import { useChildChatTabsStore } from "../../stores/childChatTabsStore";

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages: vi.fn().mockResolvedValue(true),
}));

/**
 * A probe, not a renderer.
 *
 * The panel's promise is that the transcript it mounts carries the *child's*
 * agents, so a chip row inside it can open them. Rendering real bubbles would
 * test MessageBubble; reading the context the panel provides tests the panel.
 */
vi.mock("../MessageTimeline", () => ({
  MessageTimeline: () => {
    const transcript = useConductorTranscript();
    return (
      <div data-testid="child-transcript" data-enabled={transcript.enabled}>
        {transcript.children.map((child) => (
          <button
            key={child.sessionId}
            type="button"
            data-testid="grandchild"
            onClick={() =>
              transcript.onOpenChild?.(child.sessionId, "openInTab")
            }
          >
            {child.displayName}
          </button>
        ))}
      </div>
    );
  },
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

function message(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    created: 0,
  } as Message;
}

beforeEach(() => {
  useChildChatTabsStore.setState({
    tabsBySession: {},
    activeChildIdBySession: {},
    openBySession: {},
  });
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  useChatStore.setState({ messagesBySession: {} });
});

describe("an executor's own agents, from inside its panel", () => {
  function openWorkerWithSubagent() {
    useConductorGraphStore.setState({
      nodesById: {
        "child-1": node({
          sessionId: "child-1",
          displayName: "Atlas",
          waveId: "w1",
          stepIndex: 0,
        }),
        "grand-1": node({
          sessionId: "grand-1",
          displayName: "Curie",
          parentSessionId: "child-1",
        }),
      },
      reportsByRunId: {},
    });
    useChatStore.setState({
      messagesBySession: { "child-1": [message("m1", "working")] },
    });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });
  }

  it("shows the agents the open executor started", () => {
    // The panel used to mount an inert context on purpose, so opening a
    // worker showed its words and hid the agents it had spawned.
    openWorkerWithSubagent();
    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    expect(screen.getByTestId("child-transcript")).toHaveAttribute(
      "data-enabled",
      "true",
    );
    expect(screen.getByTestId("grandchild")).toHaveTextContent("Curie");
  });

  it("opens a subagent as another tab in the same strip", async () => {
    // The recursion has no special case: a subagent's subagents open the
    // same way, from the same row of tabs.
    openWorkerWithSubagent();
    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    await userEvent.click(screen.getByTestId("grandchild"));

    expect(
      useChildChatTabsStore
        .getState()
        .tabsBySession.host?.map((tab) => tab.sessionId),
    ).toEqual(["child-1", "grand-1"]);
  });

  it("says nothing about agents for an executor that started none", () => {
    useConductorGraphStore.setState({
      nodesById: {
        "child-1": node({ sessionId: "child-1", displayName: "Atlas" }),
      },
      reportsByRunId: {},
    });
    useChatStore.setState({
      messagesBySession: { "child-1": [message("m1", "working")] },
    });
    useChildChatTabsStore
      .getState()
      .open("host", { sessionId: "child-1", name: "Atlas" });

    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    expect(screen.getByTestId("child-transcript")).toHaveAttribute(
      "data-enabled",
      "false",
    );
    expect(screen.queryByTestId("grandchild")).toBeNull();
  });

  it("offers the raw run events only for an executor that belongs to a wave", async () => {
    openWorkerWithSubagent();
    renderWithProviders(<ChildChatPanel hostSessionId="host" />);

    const toggle = screen.getByTestId("child-chat-raw-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    // Nothing has been recorded for this wave in this process, and the rail
    // says so rather than rendering an empty box.
    expect(screen.getByTestId("raw-event-rail-empty")).toBeInTheDocument();
  });
});
