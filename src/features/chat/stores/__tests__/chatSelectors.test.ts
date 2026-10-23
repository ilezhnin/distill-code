import { afterEach, expect, it } from "vitest";
import { selectSessionListActivityById } from "../chatSelectors";
import { useChatStore } from "../chatStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";

afterEach(() => useChatStore.setState({ sessionStateById: {} }));

it("keeps sidebar activity stable through streaming tokens and changing run ids", () => {
  useChatStore.setState({
    sessionStateById: {
      active: { ...INITIAL_SESSION_CHAT_RUNTIME, chatState: "thinking" },
      other: { ...INITIAL_SESSION_CHAT_RUNTIME },
    },
  });
  const before = selectSessionListActivityById(useChatStore.getState());
  const runtime = useChatStore.getState().sessionStateById.active;
  for (let i = 0; i < 100; i++) {
    useChatStore.setState({
      sessionStateById: {
        ...useChatStore.getState().sessionStateById,
        active: {
          ...runtime,
          chatState: "streaming",
          activeRunId: `run-${i}`,
          tokenState: { ...runtime.tokenState, outputTokens: i },
        },
      },
    });
    expect(selectSessionListActivityById(useChatStore.getState())).toBe(before);
  }
});

it("updates unread and running state and removes released sessions", () => {
  useChatStore.setState({
    sessionStateById: {
      active: { ...INITIAL_SESSION_CHAT_RUNTIME, chatState: "streaming" },
      other: { ...INITIAL_SESSION_CHAT_RUNTIME },
    },
  });
  const before = selectSessionListActivityById(useChatStore.getState());
  useChatStore.setState({
    sessionStateById: {
      ...useChatStore.getState().sessionStateById,
      active: { ...INITIAL_SESSION_CHAT_RUNTIME, hasUnread: true },
    },
  });
  const after = selectSessionListActivityById(useChatStore.getState());
  expect(after).not.toBe(before);
  expect(after.active).toEqual({ isRunning: false, hasUnread: true });
  expect(after.other).toBe(before.other);
  useChatStore.setState({ sessionStateById: {} });
  expect(selectSessionListActivityById(useChatStore.getState())).toEqual({});
});
