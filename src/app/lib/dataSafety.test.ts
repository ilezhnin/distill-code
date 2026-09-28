import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { loadPersistedMessageQueues } from "@/features/chat/stores/queuePersistence";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  flushUsageLedger,
  getUsageLedger,
  resetUsageLedgerForTests,
  syncUsageSessions,
  noteSessionWorkState,
  getInProgressWorkMs,
} from "@/features/stats/lib/usageLedger";
import { syncConductorNodesIntoUsageLedger } from "@/features/stats/lib/usageRecorder";

beforeEach(() => {
  mockInvoke.mockReset();
  window.localStorage.clear();
  delete window.__TAURI_INTERNALS__;
  resetUsageLedgerForTests();
  useChatSessionStore.setState({ sessions: [] });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
});
afterEach(() => {
  resetUsageLedgerForTests();
  vi.useRealTimers();
  delete window.__TAURI_INTERNALS__;
});

it("an authoritative empty native queue must not revive a stale cache", async () => {
  window.__TAURI_INTERNALS__ = {};
  window.localStorage.setItem(
    "distill:chat-message-queues:v1",
    JSON.stringify({
      s1: [
        {
          kind: "transport-ready",
          recordId: "previously-removed",
          payload: {
            text: "synthetic old instruction",
            persona: { kind: "inherit" },
          },
        },
      ],
    }),
  );
  mockInvoke.mockResolvedValue(null);
  expect(await loadPersistedMessageQueues()).toEqual({});
});

it("resyncing a retained old chat must not archive its totals twice", () => {
  const source = {
    id: "old-chat",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    messageCount: 4,
    providerId: "codex-acp",
  };
  syncUsageSessions([source]);
  flushUsageLedger();
  expect(Object.keys(getUsageLedger().sessions)).toEqual(["old-chat"]);
  expect(getUsageLedger().sessions["old-chat"].messageCount).toBe(4);
  syncUsageSessions([source]);
  flushUsageLedger();
  expect(Object.keys(getUsageLedger().sessions)).toEqual(["old-chat"]);
  expect(getUsageLedger().sessions["old-chat"].messageCount).toBe(4);
});

it("removing a working chat must settle its work timer", () => {
  useChatSessionStore.setState({
    sessions: [
      {
        id: "removed-chat",
        createdAt: "2026-09-28T00:00:00Z",
        updatedAt: "2026-09-28T00:00:00Z",
        messageCount: 0,
      },
    ] as never,
  });
  noteSessionWorkState("removed-chat", "streaming", Date.now());
  vi.advanceTimersByTime(1000);
  useChatSessionStore.getState().removeSession("removed-chat");
  vi.advanceTimersByTime(60000);
  expect(getInProgressWorkMs()).toBe(0);
});

it("archive cleanup preserves unsent queues, drafts and attachments", () => {
  const queues = [
    {
      kind: "transport-ready",
      recordId: "keep",
      payload: { text: "queued", persona: { kind: "inherit" } },
    },
  ] as const;
  const attachments = [{ id: "attachment", name: "image.png" }];
  useChatStore.setState({
    queuedMessageBySession: { archived: [...queues] },
    draftsBySession: { archived: "draft text" },
    draftAttachmentsBySession: { archived: attachments as never },
    nonEmptyDraftSessionIds: new Set(["archived"]),
  });
  useChatStore.getState().cleanupSession("archived", { preserveUnsent: true });
  const state = useChatStore.getState();
  expect(state.queuedMessageBySession.archived).toEqual(queues);
  expect(state.draftsBySession.archived).toBe("draft text");
  expect(state.draftAttachmentsBySession.archived).toEqual(attachments);
  expect(state.nonEmptyDraftSessionIds.has("archived")).toBe(true);
});

it("syncing a node without creation time must not refresh its activity", () => {
  const nodes = [
    { sessionId: "old-node", role: "worker", status: "completed" },
  ];
  syncConductorNodesIntoUsageLedger(nodes);
  const first = getUsageLedger().sessions["old-node"].lastActivityAt;
  vi.advanceTimersByTime(60000);
  syncConductorNodesIntoUsageLedger(nodes);
  expect(getUsageLedger().sessions["old-node"].lastActivityAt).toBe(first);
});
