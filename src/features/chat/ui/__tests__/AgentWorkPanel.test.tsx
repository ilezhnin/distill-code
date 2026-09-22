import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Message, MessageContent } from "@/shared/types/messages";
import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import {
  createTranscriptRowStateRegistry,
  TranscriptRowStateProvider,
  type TranscriptRowStateRegistry,
} from "@/features/chat/transcript/row-state";
import { AgentWorkPanel } from "../AgentWorkPanel";

const SESSION_ID = "session-agent-work";
const ROW_ID = "row-agent-work";
const WORK_ID = "work-1";

const WORK_CONTENT: MessageContent[] = [
  { type: "thinking", text: "Deciding which file to read first." },
  {
    type: "toolRequest",
    id: "call-1",
    name: "read_file",
    toolName: "read_file",
    arguments: { path: "/repo/alpha.ts" },
    status: "completed",
    toolKind: "read",
    locations: [],
  },
  {
    type: "toolResponse",
    id: "call-1",
    name: "read_file",
    result: "alpha contents",
    isError: false,
  },
];

const MESSAGE: Message = {
  id: "assistant-1",
  role: "assistant",
  created: Date.UTC(2026, 5, 4, 12, 0, 0),
  content: WORK_CONTENT,
  metadata: { userVisible: true, completionStatus: "completed" },
};

function payload(): TranscriptAgentWorkPayload {
  return {
    workId: WORK_ID,
    messageId: MESSAGE.id,
    message: MESSAGE,
    content: WORK_CONTENT,
    parts: [],
    isActiveWork: false,
    hasFinalAnswer: true,
    hostsTurnFooters: false,
    thoughtCount: 1,
    toolCount: 1,
    textCount: 0,
  };
}

function Host({
  registry,
  children,
}: {
  registry: TranscriptRowStateRegistry;
  children: ReactNode;
}) {
  return (
    <TranscriptRowStateProvider
      registry={registry}
      sessionId={SESSION_ID}
      rowId={ROW_ID}
    >
      {children}
    </TranscriptRowStateProvider>
  );
}

function panelTrigger(): HTMLElement {
  // The settled panel's own disclosure: "Previous steps"/"Steps".
  return screen.getByRole("button", { name: /step/i });
}

/** The disclosure of the single tool card inside the panel. */
function toolTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /read_file/i });
}

describe("AgentWorkPanel durable disclosure", () => {
  let registry: TranscriptRowStateRegistry;

  beforeEach(() => {
    registry = createTranscriptRowStateRegistry();
  });

  it("restores the panel and its expanded tool card after the row is evicted and remounted", async () => {
    const user = userEvent.setup();
    const view = render(
      <Host registry={registry}>
        <AgentWorkPanel payload={payload()} />
      </Host>,
    );

    // Settled panels mount collapsed.
    expect(screen.queryByText("alpha contents")).not.toBeInTheDocument();

    await user.click(panelTrigger());
    await user.click(toolTrigger());
    expect(screen.getByText("alpha contents")).toBeInTheDocument();

    const stored = registry.getRowState({
      sessionId: SESSION_ID,
      rowId: ROW_ID,
    })?.agentWorkPanels?.[WORK_ID];
    expect(stored?.open).toBe(true);
    expect(stored?.userInteracted).toBe(true);
    expect(stored?.expandedToolKeys).toHaveLength(1);

    // Eviction from the virtual window, then a scroll back to the same row.
    view.unmount();
    render(
      <Host registry={registry}>
        <AgentWorkPanel payload={payload()} />
      </Host>,
    );

    expect(screen.getByText("alpha contents")).toBeInTheDocument();
  });

  it("still mounts an untouched settled panel collapsed", () => {
    render(
      <Host registry={registry}>
        <AgentWorkPanel payload={payload()} />
      </Host>,
    );

    expect(screen.queryByText("alpha contents")).not.toBeInTheDocument();
    const stored = registry.getRowState({
      sessionId: SESSION_ID,
      rowId: ROW_ID,
    })?.agentWorkPanels?.[WORK_ID];
    expect(stored?.userInteracted).toBe(false);
  });

  it("collapsing again is remembered too", async () => {
    const user = userEvent.setup();
    const view = render(
      <Host registry={registry}>
        <AgentWorkPanel payload={payload()} />
      </Host>,
    );

    await user.click(panelTrigger());
    await user.click(panelTrigger());
    view.unmount();

    render(
      <Host registry={registry}>
        <AgentWorkPanel payload={payload()} />
      </Host>,
    );
    expect(screen.queryByText("alpha contents")).not.toBeInTheDocument();
    const stored = registry.getRowState({
      sessionId: SESSION_ID,
      rowId: ROW_ID,
    })?.agentWorkPanels?.[WORK_ID];
    expect(stored?.open).toBe(false);
    expect(stored?.userInteracted).toBe(true);
  });
});

describe("AgentWorkPanel step actions", () => {
  let registry: TranscriptRowStateRegistry;

  beforeEach(() => {
    registry = createTranscriptRowStateRegistry();
  });

  const steppedPayload = (): TranscriptAgentWorkPayload => ({
    ...payload(),
    content: [{ type: "text", text: "Mapping the codebase." }, ...WORK_CONTENT],
    parts: [
      { kind: "text", ordinal: 0 },
      { kind: "reasoning", ordinal: 0 },
      { kind: "tool", toolCallId: "call-1" },
      { kind: "tool", toolCallId: "call-1" },
    ],
    textCount: 1,
  });

  it("offers to edit a text or thought step and to remove any step, naming it to the owner", async () => {
    const user = userEvent.setup();
    const onEditPart = vi.fn();
    const onRemovePart = vi.fn();
    render(
      <Host registry={registry}>
        <AgentWorkPanel
          payload={steppedPayload()}
          onEditPart={onEditPart}
          onRemovePart={onRemovePart}
        />
      </Host>,
    );
    await user.click(panelTrigger());

    const editButtons = screen.getAllByRole("button", { name: "Edit step" });
    const removeButtons = screen.getAllByRole("button", {
      name: "Remove step",
    });
    // The text step and the thought can be edited; the tool call only removed.
    expect(editButtons).toHaveLength(2);
    expect(removeButtons).toHaveLength(3);

    await user.click(editButtons[0] as HTMLElement);
    expect(onEditPart).toHaveBeenCalledWith("assistant-1", {
      kind: "text",
      ordinal: 0,
    });
    await user.click(editButtons[1] as HTMLElement);
    expect(onEditPart).toHaveBeenLastCalledWith("assistant-1", {
      kind: "reasoning",
      ordinal: 0,
    });
    await user.click(removeButtons[2] as HTMLElement);
    expect(onRemovePart).toHaveBeenCalledWith("assistant-1", {
      kind: "tool",
      toolCallId: "call-1",
    });
  });

  it("offers nothing while the work is still running, or without an owner to tell", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Host registry={registry}>
        <AgentWorkPanel
          payload={{ ...steppedPayload(), isActiveWork: true }}
          onEditPart={vi.fn()}
          onRemovePart={vi.fn()}
        />
      </Host>,
    );
    expect(screen.queryByRole("button", { name: "Edit step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove step" })).toBeNull();
    unmount();

    render(
      <Host registry={registry}>
        <AgentWorkPanel payload={steppedPayload()} />
      </Host>,
    );
    await user.click(panelTrigger());
    expect(screen.queryByRole("button", { name: "Edit step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove step" })).toBeNull();
  });
});
