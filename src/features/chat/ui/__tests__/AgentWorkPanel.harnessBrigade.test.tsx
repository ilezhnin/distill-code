import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { revealHarnessSubagentToolCall } from "@/features/chat/lib/harnessBrigadeFocus";
import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import type { MessageContent } from "@/shared/types/messages";
import { renderWithProviders } from "@/test/render";

import { AgentWorkPanel } from "../AgentWorkPanel";

const scrollIntoView = vi.fn();

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  scrollIntoView.mockClear();
});

afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const CONTENT: MessageContent[] = [
  {
    type: "toolRequest",
    id: "toolu_01",
    name: "Task",
    toolName: "Task",
    arguments: {
      subagent_type: "code-reviewer",
      description: "Review the auth module",
    },
    status: "completed",
  },
  {
    type: "toolResponse",
    id: "toolu_01",
    name: "Task",
    result: "2 findings",
    isError: false,
  },
  {
    type: "toolRequest",
    id: "toolu_02",
    name: "Task",
    toolName: "Task",
    arguments: {
      subagent_type: "test-writer",
      description: "Write tests for the parser",
    },
    status: "in_progress",
  },
];

function payload(
  overrides: Partial<TranscriptAgentWorkPayload> = {},
): TranscriptAgentWorkPayload {
  return {
    workId: "work-1",
    message: {
      id: "assistant-1",
      role: "assistant",
      created: 0,
      content: CONTENT,
    },
    content: CONTENT,
    isActiveWork: true,
    hasFinalAnswer: false,
    thoughtCount: 0,
    toolCount: 2,
    textCount: 0,
    ...overrides,
  };
}

describe("AgentWorkPanel harness brigade strip", () => {
  it("shows a live chip per in-harness subagent while the turn works", () => {
    renderWithProviders(<AgentWorkPanel payload={payload()} />);

    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-status", "completed");
    expect(chips[0]).toHaveTextContent("code-reviewer");
    expect(chips[1]).toHaveAttribute("data-status", "running");
    expect(chips[1]).toHaveTextContent("test-writer");
  });

  it("hands the strip over to the finished message once the work settles", () => {
    renderWithProviders(
      <AgentWorkPanel
        payload={payload({ isActiveWork: false, hasFinalAnswer: true })}
      />,
    );

    expect(screen.queryByTestId("harness-brigade-row")).toBeNull();
  });

  it("expands and scrolls to the tool card of the clicked chip", () => {
    renderWithProviders(
      <AgentWorkPanel
        payload={payload({ isActiveWork: false, hasFinalAnswer: true })}
      />,
    );

    // The settled panel is collapsed: its tool cards are not even mounted.
    expect(document.querySelector("[data-tool-call-id]")).toBeNull();

    // A chip elsewhere in the transcript (the row under the answer) asks for
    // this panel's card.
    act(() => {
      revealHarnessSubagentToolCall("toolu_02");
    });

    expect(
      document.querySelector("[data-tool-call-id='toolu_02']"),
    ).not.toBeNull();
  });

  it("ignores a reveal for a tool call it does not own", () => {
    renderWithProviders(
      <AgentWorkPanel
        payload={payload({ isActiveWork: false, hasFinalAnswer: true })}
      />,
    );

    expect(() =>
      act(() => {
        revealHarnessSubagentToolCall("toolu_99");
      }),
    ).not.toThrow();
    expect(document.querySelector("[data-tool-call-id]")).toBeNull();
  });

  it("reveals a card from the live panel when its chip is clicked", () => {
    renderWithProviders(<AgentWorkPanel payload={payload()} />);

    fireEvent.click(screen.getAllByTestId("conductor-agent-chip")[0]);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});
