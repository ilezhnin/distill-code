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
  RATE_LIMIT_ACCOUNT_SPACING_MS,
  RATE_LIMIT_FIRST_WAIT_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  resetRateLimitPacingForTesting,
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
    resetRateLimitPacingForTesting();
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

  describe("a rate-limit refusal before the turn began", () => {
    const refused = (accountId = "a1") => ({
      code: -32011,
      data: {
        kind: "provider_rate_limit_wait",
        accountId,
        dispatchStarted: false,
        promptNotAccepted: true,
        refused: "exceeded retry limit, last status: 429 Too Many Requests",
      },
    });

    beforeEach(() => {
      useChatSessionStore.setState({
        sessions: ["s1", "s2", "s3"].map((id) => ({
          id,
          title: "Invented worker",
          executionTarget: { harnessId: "codex-acp" },
          accountId: "a1",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        })),
      });
    });

    it("parks the message like a quota wait and sends it again after the first wait", async () => {
      expect(accountQuotaWaitData(refused())?.promptNotAccepted).toBe(true);
      expect(deferForAccountQuota("s1", refused())).toBe(true);
      const wait = useAccountQuotaWaitStore.getState().waits.s1;
      expect(wait?.reason).toBe("rate_limit");
      expect(wait?.retryAt).toBe(Date.now() + RATE_LIMIT_FIRST_WAIT_MS);
      expect(
        isQueuedSessionReady(useChatStore.getState().getSessionRuntime("s1")),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_FIRST_WAIT_MS - 1);
      expect(isAccountQuotaWaiting("s1")).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(isAccountQuotaWaiting("s1")).toBe(false);
      expect(
        isQueuedSessionReady(useChatStore.getState().getSessionRuntime("s1")),
      ).toBe(true);
    });

    it("waits longer with each refusal in a row, up to five minutes", async () => {
      const waits: number[] = [];
      for (let refusal = 0; refusal < 7; refusal += 1) {
        deferForAccountQuota("s1", refused());
        const wait = useAccountQuotaWaitStore.getState().waits.s1;
        waits.push((wait?.retryAt ?? 0) - Date.now());
        await vi.advanceTimersByTimeAsync(wait ? wait.retryAt - Date.now() : 0);
      }
      expect(waits).toEqual([
        15_000,
        30_000,
        60_000,
        120_000,
        240_000,
        RATE_LIMIT_MAX_WAIT_MS,
        RATE_LIMIT_MAX_WAIT_MS,
      ]);
      // A refusal long after the last starts the count over.
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      deferForAccountQuota("s1", refused());
      expect(
        (useAccountQuotaWaitStore.getState().waits.s1?.retryAt ?? 0) -
          Date.now(),
      ).toBe(RATE_LIMIT_FIRST_WAIT_MS);
    });

    it("sends a burst refused on one account back one at a time", () => {
      for (const id of ["s1", "s2", "s3"]) deferForAccountQuota(id, refused());
      const retryAts = ["s1", "s2", "s3"].map(
        (id) => useAccountQuotaWaitStore.getState().waits[id]?.retryAt ?? 0,
      );
      const start = Date.now() + RATE_LIMIT_FIRST_WAIT_MS;
      expect(retryAts).toEqual([
        start,
        start + RATE_LIMIT_ACCOUNT_SPACING_MS,
        start + 2 * RATE_LIMIT_ACCOUNT_SPACING_MS,
      ]);
      // Another account is not held back by this one's burst.
      deferForAccountQuota("s4", refused("a2"));
      expect(useAccountQuotaWaitStore.getState().waits.s4?.retryAt).toBe(start);
    });

    it("is not lifted by a fresh account status, which said ready before the refusal too", async () => {
      useProviderAccountsStore.setState({
        accounts: [
          {
            id: "a1",
            providerId: "codex-acp",
            label: "Work",
            authMethod: "oauth",
            enabled: true,
            autoSwitch: true,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });
      deferForAccountQuota("s1", refused());
      await vi.advanceTimersByTimeAsync(0);
      useProviderAccountsStore.setState({
        statuses: {
          a1: {
            accountId: "a1",
            providerId: "codex-acp",
            state: "ready",
            subscription: null,
            accountLabel: null,
            limits: [],
            resetTokens: null,
            credits: null,
            lastUpdatedAt: Date.now() + 1,
            lastAttemptAt: Date.now() + 1,
            stale: false,
            error: null,
          },
        },
      });
      expect(isAccountQuotaWaiting("s1")).toBe(true);
    });
  });
});
