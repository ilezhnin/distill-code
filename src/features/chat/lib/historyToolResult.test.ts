import { beforeEach, expect, it, vi } from "vitest";
import { useChatStore } from "../stores/chatStore";
import { loadHistoryToolResult } from "./historyToolResult";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({ host: { sessionHistoryResult: read } }),
}));

beforeEach(() => {
  read.mockReset();
  useChatStore.setState({
    messagesBySession: {
      one: [
        {
          id: "reply",
          role: "assistant",
          created: 0,
          content: [
            {
              type: "toolRequest",
              id: "t",
              name: "Read",
              arguments: {},
              status: "completed",
            },
            {
              type: "toolResponse",
              id: "t",
              name: "Read",
              result: "",
              isError: false,
              historyResult: { sessionId: "one", eventId: 3 },
            },
          ],
        },
      ],
    },
  });
});

it("coalesces explicit result reads and hydrates the original response once", async () => {
  read.mockResolvedValue({
    sessionId: "one",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      rawOutput: "saved output",
    },
  });
  const ref = { sessionId: "one", eventId: 3 };
  await Promise.all([loadHistoryToolResult(ref), loadHistoryToolResult(ref)]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    useChatStore.getState().messagesBySession.one[0].content[1],
  ).toMatchObject({ result: "saved output" });
  expect(
    useChatStore.getState().messagesBySession.one[0].content[1],
  ).not.toHaveProperty("historyResult");
});

it("does not replace content with a response from a different session", async () => {
  read.mockResolvedValue({
    sessionId: "two",
    update: { sessionUpdate: "tool_call_update", toolCallId: "t" },
  });
  await expect(
    loadHistoryToolResult({ sessionId: "one", eventId: 3 }),
  ).rejects.toThrow("does not match");
  expect(
    useChatStore.getState().messagesBySession.one[0].content[1],
  ).toHaveProperty("historyResult");
});
