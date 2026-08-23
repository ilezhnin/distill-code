import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { groupBrigadeNodesByHostMessage } from "@/features/conductor/brigadeAnchors";
import {
  ConductorTranscriptProvider,
  type ConductorTranscriptContextValue,
} from "@/features/conductor/ConductorTranscriptContext";
import type { SessionNode } from "@/features/conductor/types";
import type { Message } from "@/shared/types/messages";

import { MessageBubble } from "../MessageBubble";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

function message(id: string, role: Message["role"], text: string): Message {
  return { id, role, created: 0, content: [{ type: "text", text }] };
}

const MESSAGES: Message[] = [
  message("u1", "user", "first request"),
  message("a1", "assistant", "first answer"),
  message("u2", "user", "second request"),
  message("a2", "assistant", "second answer"),
];

function node(
  sessionId: string,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status: "running",
    ...overrides,
  };
}

function renderTranscript(
  nodes: SessionNode[],
  handlers: Partial<ConductorTranscriptContextValue> = {},
) {
  const value: ConductorTranscriptContextValue = {
    enabled: true,
    children: nodes,
    reportsByRunId: {},
    messages: MESSAGES,
    brigadeNodesByMessageId: groupBrigadeNodesByHostMessage(nodes, MESSAGES),
    ...handlers,
  };
  return render(
    <ConductorTranscriptProvider value={value}>
      {MESSAGES.map((item) => (
        <MessageBubble key={item.id} message={item} animateEntry={false} />
      ))}
    </ConductorTranscriptProvider>,
  );
}

function bubbleFor(container: HTMLElement, text: string): HTMLElement {
  const bubble = screen.getByText(text).closest("[data-role$='-message']");
  if (!(bubble instanceof HTMLElement)) {
    throw new Error(`no bubble for ${text} in ${container.innerHTML.length}`);
  }
  return bubble;
}

describe("MessageBubble conductor footer", () => {
  it("keeps each wave under the message it is anchored to", () => {
    const { container } = renderTranscript([
      node("Kepler", { anchorMessageId: "a1" }),
      node("Curie", { anchorMessageId: "a1" }),
      node("Bohr", { anchorMessageId: "a2" }),
    ]);

    const first = bubbleFor(container, "first answer");
    const second = bubbleFor(container, "second answer");

    expect(
      within(first)
        .getAllByTestId("conductor-agent-chip")
        .map((chip) => chip.textContent),
    ).toEqual(["Kepler", "Curie"]);
    expect(
      within(second)
        .getAllByTestId("conductor-agent-chip")
        .map((chip) => chip.textContent),
    ).toEqual(["Bohr"]);
    expect(
      container.querySelectorAll("[data-testid=conductor-agent-footer]"),
    ).toHaveLength(2);
  });

  it("renders nothing under messages that own no children", () => {
    const { container } = renderTranscript([
      node("Kepler", { anchorMessageId: "a1" }),
    ]);

    expect(
      within(bubbleFor(container, "second answer")).queryByTestId(
        "conductor-agent-footer",
      ),
    ).toBeNull();
    expect(
      within(bubbleFor(container, "first request")).queryByTestId(
        "conductor-agent-footer",
      ),
    ).toBeNull();
  });

  it("puts unanchored children on the latest message only", () => {
    const { container } = renderTranscript([node("Kepler")]);

    expect(
      within(bubbleFor(container, "second answer")).getByTestId(
        "conductor-agent-chip",
      ),
    ).toHaveTextContent("Kepler");
    expect(
      within(bubbleFor(container, "first answer")).queryByTestId(
        "conductor-agent-footer",
      ),
    ).toBeNull();
  });

  it("renders the chip row below the actions/timestamp row, outside the reserved space", () => {
    const { container } = renderTranscript([
      node("Kepler", { anchorMessageId: "a1" }),
    ]);

    const bubble = bubbleFor(container, "first answer");
    const content = bubble.querySelector<HTMLElement>(
      '[data-role="assistant-message-content"]',
    );
    const footer = within(bubble).getByTestId("conductor-agent-footer");
    const actions = bubble.querySelector<HTMLElement>(
      '[data-role="message-actions"]',
    );
    if (!content || !actions) throw new Error("expected content and actions");

    // The actions tray is absolutely positioned inside the reserved (pb-9)
    // content box; the chip row must sit after that box in normal flow.
    expect(content.contains(actions)).toBe(true);
    expect(content.contains(footer)).toBe(false);
    expect(content.className).toContain("pb-9");
    expect(footer.className).not.toContain("pb-9");
    expect(
      content.compareDocumentPosition(footer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(footer.parentElement).toBe(content.parentElement);
  });

  it("opens the child session in a tab from a chip click", () => {
    const onOpenChild = vi.fn();
    const { container } = renderTranscript(
      [node("Kepler", { anchorMessageId: "a1" })],
      { onOpenChild },
    );

    fireEvent.click(
      within(bubbleFor(container, "first answer")).getByTestId(
        "conductor-agent-chip",
      ),
    );

    // A chip click asks for the transcript beside the conversation; full
    // navigation is the tab header's explicit "open fully" control.
    expect(onOpenChild).toHaveBeenCalledWith("Kepler", "openInTab");
  });

  it("renders no chips when the transcript is not a conductor chat", () => {
    const nodes = [node("Kepler", { anchorMessageId: "a1" })];
    const { container } = render(
      <ConductorTranscriptProvider
        value={{
          enabled: false,
          children: nodes,
          reportsByRunId: {},
          messages: MESSAGES,
          brigadeNodesByMessageId: groupBrigadeNodesByHostMessage(
            nodes,
            MESSAGES,
          ),
        }}
      >
        {MESSAGES.map((item) => (
          <MessageBubble key={item.id} message={item} animateEntry={false} />
        ))}
      </ConductorTranscriptProvider>,
    );

    expect(
      container.querySelector("[data-testid=conductor-agent-footer]"),
    ).toBeNull();
  });
});
