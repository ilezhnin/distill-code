import { beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "./chatStore";
import { loadCompleteHistory, useChatHistoryStore } from "./chatHistoryStore";

const { read, parse, hydrate, toastError } = vi.hoisted(() => ({
  read: vi.fn(),
  parse: vi.fn(),
  hydrate: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/shared/api/acpApi", () => ({ readHistoryPage: read }));
vi.mock("../acp/acpNotificationHandler", () => ({ parseHistoryPage: parse }));
vi.mock("../lib/historyToolResult", () => ({
  loadHistoryToolResults: hydrate,
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

function message(id: string): Message {
  return {
    id,
    role: "user",
    created: 1,
    content: [{ type: "text", text: id }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().cleanupSession("history-test");
  useChatStore.setState({
    messagesBySession: { "history-test": [message("latest")] },
  });
  useChatHistoryStore.getState().accept("history-test", 100);
  parse.mockResolvedValue([message("earlier"), message("latest")]);
  hydrate.mockResolvedValue(undefined);
});

it("coalesces page reads and prepends without duplicating boundary messages", async () => {
  read.mockResolvedValue({ events: [], olderCursor: 50 });
  await Promise.all([
    useChatHistoryStore.getState().loadOlder("history-test"),
    useChatHistoryStore.getState().loadOlder("history-test"),
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    useChatStore.getState().messagesBySession["history-test"].map((m) => m.id),
  ).toEqual(["earlier", "latest"]);
  expect(useChatHistoryStore.getState().pages["history-test"].cursor).toBe(50);
});

it("rejects a stalled cursor without replacing the current transcript", async () => {
  read.mockResolvedValue({ events: [], olderCursor: 100 });
  await useChatHistoryStore.getState().loadOlder("history-test");
  expect(useChatHistoryStore.getState().pages["history-test"].error).toContain(
    "did not advance",
  );
  expect(
    useChatStore.getState().messagesBySession["history-test"],
  ).toHaveLength(1);
});

it("ignores a released page and allows a new read before the old one settles", async () => {
  const old = deferred<{ events: never[]; olderCursor: null }>();
  read
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ events: [], olderCursor: null });
  const first = useChatHistoryStore.getState().loadOlder("history-test");
  useChatStore.getState().cleanupSession("history-test");
  useChatHistoryStore.getState().accept("history-test", 200);
  await useChatHistoryStore.getState().loadOlder("history-test");
  old.resolve({ events: [], olderCursor: null });
  await first;
  expect(read).toHaveBeenCalledTimes(2);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(
    useChatHistoryStore.getState().pages["history-test"].cursor,
  ).toBeNull();
});

it("keeps search busy until all pages and deferred results have loaded", async () => {
  const results = deferred<void>();
  read
    .mockResolvedValueOnce({ events: [], olderCursor: 50 })
    .mockResolvedValueOnce({ events: [], olderCursor: null });
  hydrate.mockReturnValueOnce(results.promise);
  const first = loadCompleteHistory("history-test");
  expect(loadCompleteHistory("history-test")).toBe(first);
  await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
  expect(read.mock.calls.map((call) => call[1])).toEqual([100, 50]);
  expect(useChatHistoryStore.getState().searching["history-test"]).toBe(true);
  results.resolve();
  await first;
  expect(
    useChatHistoryStore.getState().searching["history-test"],
  ).toBeUndefined();
});

it("stops a released full search before reading any additional pages or results", async () => {
  const page = deferred<{ events: never[]; olderCursor: number }>();
  read.mockReturnValueOnce(page.promise);
  const search = loadCompleteHistory("history-test");
  useChatStore.getState().cleanupSession("history-test");
  page.resolve({ events: [], olderCursor: 50 });
  await search;
  expect(read).toHaveBeenCalledTimes(1);
  expect(hydrate).not.toHaveBeenCalled();
  expect(
    useChatHistoryStore.getState().searching["history-test"],
  ).toBeUndefined();
});
