import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Message } from "@/shared/types/messages";
import { VirtualMessageTimelineGate } from "../VirtualMessageTimelineGate";

const mocks = vi.hoisted(() => ({
  virtualTimelineSpy: vi.fn(),
}));

vi.mock("../VirtualMessageTimeline", () => ({
  VirtualMessageTimeline: (props: {
    loadedTranscript: { id: string };
    sessionId: string;
    messages: Message[];
    footer?: ReactNode;
  }) => {
    mocks.virtualTimelineSpy(props);
    return (
      <div data-testid="virtual-message-timeline">
        <span>{props.sessionId}</span>
        {props.messages.map((message) => (
          <div key={message.id}>{message.id}</div>
        ))}
        {props.footer}
      </div>
    );
  },
}));

function message(id: string): Message {
  return {
    id,
    role: "user",
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [{ type: "text", text: id }],
    metadata: { userVisible: true },
  };
}

describe("VirtualMessageTimelineGate", () => {
  beforeEach(() => {
    mocks.virtualTimelineSpy.mockClear();
  });

  it("renders the virtual timeline with the session's messages and footer", () => {
    render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
        footer={<div data-testid="footer" />}
      />,
    );

    expect(screen.getByTestId("virtual-message-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("footer")).toBeInTheDocument();
    expect(mocks.virtualTimelineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        messages: [expect.objectContaining({ id: "user-1" })],
      }),
    );
  });

  it("keeps one loaded transcript per session and replaces it when the session changes", () => {
    const view = render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
      />,
    );
    const first = mocks.virtualTimelineSpy.mock.lastCall?.[0].loadedTranscript;

    view.rerender(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1"), message("user-2")]}
      />,
    );
    expect(mocks.virtualTimelineSpy.mock.lastCall?.[0].loadedTranscript).toBe(
      first,
    );

    view.rerender(
      <VirtualMessageTimelineGate
        sessionId="session-2"
        messages={[message("user-1")]}
      />,
    );
    const replacement =
      mocks.virtualTimelineSpy.mock.lastCall?.[0].loadedTranscript;
    expect(replacement).not.toBe(first);
    expect(replacement?.id).not.toBe(first?.id);
  });
});
