import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useChatStore,
  type QueuedMessageRecord,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import {
  accountQuotaWaitData,
  clearAccountQuotaWait,
  deferForAccountQuota,
  isAccountQuotaWaiting,
  useAccountQuotaWaitStore,
} from "./accountQuotaWait";
import { isQueuedSessionReady } from "./queuedMessageReadiness";

describe("account quota waiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s1",
          title: "Chat",
          executionTarget: { harnessId: "codex-acp" },
          accountId: "a1",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        },
      ],
    });
    useProviderAccountsStore.setState({
      accounts: [],
      statuses: {},
      defaults: {},
      automaticSwitching: {},
    });
  });

  afterEach(() => {
    for (const id of Object.keys(useAccountQuotaWaitStore.getState().waits))
      clearAccountQuotaWait(id);
    vi.useRealTimers();
  });

  it("retains readiness blocking until the declared reset rather than polling repeatedly", async () => {
    const nextReset = Math.floor(Date.now() / 1000) + 120;
    deferForAccountQuota("s1", {
      data: { kind: "account_quota_wait", nextReset, accountId: "a1" },
    });
    expect(
      isQueuedSessionReady(useChatStore.getState().getSessionRuntime("s1")),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(isAccountQuotaWaiting("s1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(isAccountQuotaWaiting("s1")).toBe(false);
    expect(
      isQueuedSessionReady(useChatStore.getState().getSessionRuntime("s1")),
    ).toBe(true);
  });

  it("uses a one minute retry for unknown or stale reset times", async () => {
    deferForAccountQuota("s1", {
      data: { kind: "account_quota_wait", nextReset: 1 },
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(isAccountQuotaWaiting("s1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(isAccountQuotaWaiting("s1")).toBe(false);
  });

  it("wakes immediately after an explicit account switch", () => {
    deferForAccountQuota("s1", {
      data: { kind: "account_quota_wait", accountId: "a1" },
    });
    useChatSessionStore.getState().patchSession("s1", { accountId: "a2" });
    expect(isAccountQuotaWaiting("s1")).toBe(false);
  });

  it("wakes on fresh available fallback quota while ignoring stale status", async () => {
    useProviderAccountsStore.setState({
      automaticSwitching: { "codex-acp": true },
      accounts: [
        {
          id: "a2",
          providerId: "codex-acp",
          label: "Fallback",
          authMethod: "oauth",
          enabled: true,
          autoSwitch: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    deferForAccountQuota("s1", {
      data: { kind: "account_quota_wait", accountId: "a1" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const status = {
      accountId: "a2",
      providerId: "codex-acp",
      state: "ready" as const,
      subscription: null,
      accountLabel: null,
      limits: [],
      resetTokens: null,
      credits: null,
      lastUpdatedAt: Date.now() + 1,
      lastAttemptAt: Date.now() + 1,
      stale: true,
      error: null,
    };
    useProviderAccountsStore.setState({ statuses: { a2: status } });
    expect(isAccountQuotaWaiting("s1")).toBe(true);
    useProviderAccountsStore.setState({
      statuses: { a2: { ...status, stale: false } },
    });
    expect(isAccountQuotaWaiting("s1")).toBe(false);
  });

  it("restores the exact unaccepted queue head before newer messages without replacing edits", () => {
    const first: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "first",
      payload: { text: "first", persona: { kind: "none" } },
    };
    const next: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "next",
      payload: { text: "next", persona: { kind: "inherit" } },
    };
    useChatStore.setState({ queuedMessageBySession: { s1: [next] } });
    useChatStore.getState().restoreUnacceptedQueuedMessage("s1", first);
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual([
      first,
      next,
    ]);
    expect(useChatStore.getState().queuedMessageBySession.s1[0]).toBe(first);
    useChatStore
      .getState()
      .updateQueuedMessage("s1", "first", { ...first.payload, text: "edited" });
    useChatStore.getState().restoreUnacceptedQueuedMessage("s1", first);
    expect(
      useChatStore.getState().queuedMessageBySession.s1[0].payload.text,
    ).toBe("edited");
  });

  it("does not treat ordinary errors or textual quota mentions as deferrals", () => {
    expect(accountQuotaWaitData(new Error("account_quota_wait"))).toBeNull();
    expect(deferForAccountQuota("s1", { data: "quota exceeded" })).toBe(false);
  });
});
