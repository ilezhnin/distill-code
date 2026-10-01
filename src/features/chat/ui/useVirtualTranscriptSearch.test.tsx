import { createRef, useEffect, useRef } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import type { TranscriptSearchBackend } from "../lib/transcriptSearchBackend";
import { createTranscriptProjectionCache } from "../transcript/projection";
import {
  createTranscriptRowStateRegistry,
  useTranscriptRowStateAdapter,
} from "../transcript/row-state";
import { useVirtualTranscriptSearch } from "./useVirtualTranscriptSearch";
import { useChatTranscriptSearch } from "../hooks/useChatTranscriptSearch";

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ message }: { message: Message }) => {
    const { updateRowState } = useTranscriptRowStateAdapter();
    useEffect(() => {
      updateRowState((state) => ({ ...state }), { markRecent: false });
    }, [updateRowState]);
    return (
      <p>
        {message.content[0]?.type === "text" ? message.content[0].text : ""}
      </p>
    );
  },
}));
vi.mock("./AgentWorkPanel", () => ({ AgentWorkPanel: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("defers search navigation until history loading completes", async () => {
  vi.useFakeTimers();
  const root = createRef<HTMLDivElement>();
  const backend = createRef<TranscriptSearchBackend>();
  const setQuery = vi.fn();
  backend.current = {
    setQuery,
    navigate: vi.fn(),
    clear: vi.fn(),
    subscribe: () => () => {},
    getSnapshot: () => ({ total: 0, activeOrdinal: -1, indexing: false }),
  };
  const { result, rerender } = renderHook(
    ({ loading }) =>
      useChatTranscriptSearch(root, {
        backendRef: backend,
        historyLoading: loading,
      }),
    { initialProps: { loading: true } },
  );
  act(() => {
    result.current.open();
    result.current.setQuery("earlier message");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(setQuery).not.toHaveBeenCalled();
  rerender({ loading: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(setQuery).toHaveBeenCalledWith("earlier message");
});

it("finishes multiple harvest batches when mounting rows initializes disclosure state", async () => {
  vi.useFakeTimers();
  const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`,
    role: "user",
    created: 1,
    content: [{ type: "text", text: `searchable entry ${index}` }],
  }));
  const snapshot = createTranscriptProjectionCache().update({
    sessionId: "search",
    sessionEpoch: 1,
    messages,
    streamingMessageId: null,
    nowBucket: "2026-09-28",
    localeKey: "en-US",
  });
  const backend = createRef<TranscriptSearchBackend>();
  const registry = createTranscriptRowStateRegistry();
  const rowStateProvider = {
    registry,
    sessionId: "search",
    sessionEpoch: 1,
    onRowStateChange: () => {},
  };
  const messageByRowId = new Map(
    snapshot.rows.flatMap((row) => {
      const message = messages.find((message) => message.id === row.messageId);
      return message ? [[row.rowId, message] as const] : [];
    }),
  );
  function Harness() {
    const root = useRef<HTMLDivElement>(null);
    const search = useVirtualTranscriptSearch({
      rows: snapshot.rows,
      messageByRowId,
      listRootRef: root,
      scrollToRow: () => true,
      rowStateProvider,
      backendRef: backend,
    });
    return <div ref={root}>{search.harvestHost}</div>;
  }
  render(<Harness />);
  act(() => backend.current?.setQuery("searchable"));
  for (let step = 0; step < 12; step++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  }
  expect(backend.current?.getSnapshot()).toMatchObject({
    total: 20,
    indexing: false,
  });
});
