import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTranscriptProjectionCache } from "@/features/chat/transcript/projection/transcriptProjectionCache";
import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import type { Message, MessageContent } from "@/shared/types/messages";
import { renderWithProviders } from "@/test/render";

import { AgentWorkPanel } from "../AgentWorkPanel";
import { MessageBubble } from "../MessageBubble";

function task(id: string, description: string): MessageContent[] {
  return [
    {
      type: "toolRequest",
      id,
      name: "Task",
      toolName: "Task",
      arguments: { subagent_type: description, description },
      status: "completed",
    },
    {
      type: "toolResponse",
      id,
      name: "Task",
      result: "done",
      isError: false,
    },
  ];
}

function project(messages: readonly Message[], sessionId = "session-1") {
  const cache = createTranscriptProjectionCache();
  return cache.update({
    sessionId,
    sessionEpoch: 1,
    messages,
    streamingMessageId: null,
    nowBucket: "2026-06-04",
    localeKey: "en-US",
  });
}

function agentWorkPayloads(
  snapshot: ReturnType<typeof project>,
): TranscriptAgentWorkPayload[] {
  return snapshot.rows.flatMap((row) => (row.agentWork ? [row.agentWork] : []));
}

describe("persistent harness chip row: which row hosts it", () => {
  it("leaves the footers to the answer when the turn ends in text", () => {
    const snapshot = project([
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          ...task("toolu_01", "code-reviewer"),
          { type: "text", text: "All done." },
        ],
      },
    ]);

    const answerRows = snapshot.rows.filter((row) =>
      row.rowId.endsWith(":answer"),
    );
    expect(answerRows).toHaveLength(1);
    // Exactly one row hosts the chips, and it is the answer bubble.
    expect(
      agentWorkPayloads(snapshot).filter((payload) => payload.hostsTurnFooters),
    ).toHaveLength(0);
  });

  it("hands the footers to the last work group when the turn ends in tool calls", () => {
    const snapshot = project([
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: task("toolu_01", "code-reviewer"),
      },
    ]);

    expect(
      snapshot.rows.filter((row) => row.rowId.endsWith(":answer")),
    ).toEqual([]);
    const payloads = agentWorkPayloads(snapshot);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.hostsTurnFooters).toBe(true);
  });

  it("does not duplicate the row across a multi-group turn", () => {
    const snapshot = project([
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          ...task("toolu_01", "code-reviewer"),
          // A companion block is a real sequence boundary: it splits the turn
          // into two agent-work groups.
          { type: "image", mimeType: "image/png", data: "" },
          ...task("toolu_02", "test-writer"),
        ],
      },
    ]);

    const payloads = agentWorkPayloads(snapshot);
    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.hostsTurnFooters)).toEqual([
      false,
      true,
    ]);
  });

  it("renders the settled chip row only on the group that hosts the footers", () => {
    const snapshot = project([
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          ...task("toolu_01", "code-reviewer"),
          { type: "image", mimeType: "image/png", data: "" },
          ...task("toolu_02", "test-writer"),
        ],
      },
    ]);
    const [first, last] = agentWorkPayloads(snapshot);
    if (!first || !last) throw new Error("expected two work groups");

    const quiet = renderWithProviders(<AgentWorkPanel payload={first} />);
    expect(first.isActiveWork).toBe(false);
    expect(screen.queryByTestId("harness-brigade-row")).toBeNull();
    quiet.unmount();

    renderWithProviders(<AgentWorkPanel payload={last} />);
    expect(last.isActiveWork).toBe(false);
    expect(screen.getByTestId("harness-brigade-row")).toBeInTheDocument();
    expect(screen.getAllByTestId("brigade-chip")).toHaveLength(1);
  });
});

const DELEGATE: MessageContent[] = [
  {
    type: "toolRequest",
    id: "delegate-1",
    name: "delegate",
    toolName: "delegate",
    arguments: { source: "Rivet", instructions: "Count the markdown files" },
    status: "completed",
  },
  {
    type: "toolResponse",
    id: "delegate-1",
    name: "delegate",
    result: "Started background task 20260808_12",
    isError: false,
  },
];

function loadTurn(taskId: string): MessageContent[] {
  return [
    {
      type: "toolRequest",
      id: `load-${taskId}`,
      name: "load",
      toolName: "load",
      arguments: { source: taskId },
      status: "completed",
    },
    {
      type: "toolResponse",
      id: `load-${taskId}`,
      name: "load",
      result: "42 files",
      isError: false,
    },
    { type: "text", text: "There are 42 markdown files." },
  ];
}

function renderAnswerRow(snapshot: ReturnType<typeof project>) {
  const answerRow = snapshot.rows.find((row) => row.rowId.endsWith(":answer"));
  if (!answerRow?.messageId) throw new Error("no answer row");
  const message = snapshot.messageById.get(answerRow.messageId);
  if (!message) throw new Error("no answer message");

  renderWithProviders(
    <MessageBubble
      message={message}
      animateEntry={false}
      contentOverride={answerRow.messageContent}
      contentContext={answerRow.messageContentContext}
      subagentLinkage={answerRow.subagentLinkage}
      actionMessageId={answerRow.responseStartMessageId ?? answerRow.messageId}
    />,
  );
  return answerRow;
}

describe("cross-turn Goose delegate → load linkage", () => {
  it("folds a later load(task_id) into the delegate that announced it", () => {
    const snapshot = project([
      { id: "assistant-1", role: "assistant", created: 1, content: DELEGATE },
      {
        id: "assistant-2",
        role: "assistant",
        created: 2,
        content: loadTurn("20260808_12"),
      },
    ]);

    const answerRow = renderAnswerRow(snapshot);
    // The projection carried the earlier delegate onto the row that needs it.
    expect(answerRow.subagentLinkage).toBeDefined();

    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips).toHaveLength(1);
    // One subagent, named by the delegate, with the load's status — not a
    // second chip minted from the bare task id.
    expect(chips[0]).toHaveTextContent("Rivet");
    expect(chips[0]).toHaveAttribute("data-status", "completed");
  });

  it("does not attach a load with an unknown task id to a random delegate", () => {
    const snapshot = project([
      { id: "assistant-1", role: "assistant", created: 1, content: DELEGATE },
      {
        id: "assistant-2",
        role: "assistant",
        created: 2,
        content: loadTurn("20260808_99"),
      },
    ]);

    renderAnswerRow(snapshot);

    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("20260808_99");
    expect(chips[0]).not.toHaveTextContent("Rivet");
  });

  it("carries no linkage at all through a transcript without delegates", () => {
    const snapshot = project([
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          ...task("toolu_01", "code-reviewer"),
          { type: "text", text: "Done." },
        ],
      },
    ]);

    for (const row of snapshot.rows) {
      expect(row.subagentLinkage).toBeUndefined();
      expect(row.agentWork?.subagentLinkage).toBeUndefined();
    }
  });

  it("hands the same frozen linkage array back when the transcript is unchanged", () => {
    const messages: Message[] = [
      { id: "assistant-1", role: "assistant", created: 1, content: DELEGATE },
      {
        id: "assistant-2",
        role: "assistant",
        created: 2,
        content: loadTurn("20260808_12"),
      },
    ];

    const first = project(messages);
    const second = project(messages);
    const firstRow = first.rows.find((row) => row.subagentLinkage);
    const secondRow = second.rows.find((row) => row.subagentLinkage);

    // Row descriptors must not churn just because the projection re-ran.
    expect(firstRow?.subagentLinkage).toBeDefined();
    expect(secondRow?.subagentLinkage).toBe(firstRow?.subagentLinkage);
  });

  it("does not let a second transcript evict the first one's linkage", () => {
    // Since the child-chat panel shipped, a host conversation and a child
    // transcript are projected side by side and interleave on every streamed
    // token. A single shared memo made each projection replace the other's
    // entry, so both arrays churned on every token — the exact churn the memo
    // exists to prevent.
    const host: Message[] = [
      { id: "host-1", role: "assistant", created: 1, content: DELEGATE },
      {
        id: "host-2",
        role: "assistant",
        created: 2,
        content: loadTurn("20260808_12"),
      },
    ];
    const child: Message[] = [
      {
        id: "child-1",
        role: "assistant",
        created: 1,
        content: [
          {
            type: "toolRequest",
            id: "delegate-2",
            name: "delegate",
            toolName: "delegate",
            arguments: { source: "Bohr", instructions: "Count the tests" },
            status: "completed",
          },
          {
            type: "toolResponse",
            id: "delegate-2",
            name: "delegate",
            result: "Started background task 20260808_99",
            isError: false,
          },
        ],
      },
      {
        id: "child-2",
        role: "assistant",
        created: 2,
        content: loadTurn("20260808_99"),
      },
    ];

    const hostFirst = project(host, "host-session");
    project(child, "child-session");
    const hostSecond = project(host, "host-session");

    const before = hostFirst.rows.find((row) => row.subagentLinkage);
    const after = hostSecond.rows.find((row) => row.subagentLinkage);
    expect(before?.subagentLinkage).toBeDefined();
    expect(after?.subagentLinkage).toBe(before?.subagentLinkage);
  });
});
