import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTranscriptProjectionCache } from "@/features/chat/transcript/projection/transcriptProjectionCache";
import type { Message, MessageContent } from "@/shared/types/messages";
import { renderWithProviders } from "@/test/render";

import { MessageBubble } from "../MessageBubble";

const TURN: MessageContent[] = [
  { type: "text", text: "Fanning the work out." },
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
  { type: "text", text: "Both subagents are done; here is the summary." },
];

const MESSAGES: Message[] = [
  {
    id: "user-1",
    role: "user",
    created: 1,
    content: [{ type: "text", text: "go" }],
  },
  { id: "assistant-1", role: "assistant", created: 2, content: TURN },
];

function projectTurn() {
  const cache = createTranscriptProjectionCache();
  return cache.update({
    sessionId: "session-1",
    sessionEpoch: 1,
    messages: MESSAGES,
    streamingMessageId: null,
    nowBucket: "2026-06-04",
    localeKey: "en-US",
  });
}

describe("harness brigade under the finished answer", () => {
  it("keeps the turn's tool calls reachable from the answer row", () => {
    const snapshot = projectTurn();
    const answerRow = snapshot.rows.find((row) =>
      row.rowId.endsWith(":answer"),
    );

    expect(answerRow).toBeDefined();
    expect(answerRow?.messageContent?.map((block) => block.type)).toEqual([
      "text",
    ]);
    expect(
      answerRow?.messageContentContext?.filter(
        (block) => block.type === "toolRequest",
      ),
    ).toHaveLength(2);
  });

  it("renders the persistent chip row in a plain chat, with no conductor graph in sight", () => {
    const snapshot = projectTurn();
    const answerRow = snapshot.rows.find((row) =>
      row.rowId.endsWith(":answer"),
    );
    if (!answerRow?.messageId) throw new Error("no answer row");
    const message = snapshot.messageById.get(answerRow.messageId);
    if (!message) throw new Error("no answer message");

    renderWithProviders(
      <MessageBubble
        message={message}
        animateEntry={false}
        contentOverride={answerRow.messageContent}
        contentContext={answerRow.messageContentContext}
        actionMessageId={
          answerRow.responseStartMessageId ?? answerRow.messageId
        }
      />,
    );

    expect(screen.getByTestId("harness-brigade-row")).toBeInTheDocument();
    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("code-reviewer");
    expect(chips[0]).toHaveAttribute("data-status", "completed");
    // The turn is over, so the subagent that never reported is terminalized.
    expect(chips[1]).toHaveTextContent("test-writer");
    expect(chips[1]).toHaveAttribute("data-status", "cancelled");
    // No session behind an in-harness subagent: nothing to stop.
    expect(screen.queryByTestId("conductor-agent-stop")).toBeNull();
    // The answer itself still renders only its own text.
    expect(
      screen.getByText("Both subagents are done; here is the summary."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Fanning the work out.")).toBeNull();
  });

  it("leaves the row to the answer, not to a companion block of the same turn", () => {
    const snapshot = projectTurn();
    const answerRow = snapshot.rows.find((row) =>
      row.rowId.endsWith(":answer"),
    );
    if (!answerRow?.messageId) throw new Error("no answer row");
    const message = snapshot.messageById.get(answerRow.messageId);
    if (!message) throw new Error("no answer message");

    // A companion row (image, MCP app) carries the same turn context but
    // renders a non-text block of its own.
    renderWithProviders(
      <MessageBubble
        message={message}
        animateEntry={false}
        contentOverride={[{ type: "image", mimeType: "image/png", data: "" }]}
        contentContext={answerRow.messageContentContext}
      />,
    );

    expect(screen.queryByTestId("harness-brigade-row")).toBeNull();
  });

  it("shows no chip row for an assistant turn without subagents", () => {
    renderWithProviders(
      <MessageBubble
        message={{
          id: "assistant-2",
          role: "assistant",
          created: 3,
          content: [{ type: "text", text: "just an answer" }],
        }}
        animateEntry={false}
      />,
    );

    expect(screen.queryByTestId("harness-brigade-row")).toBeNull();
  });
});
