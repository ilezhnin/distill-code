import { describe, expect, it } from "vitest";
import type {
  ProviderAccountResetCredit,
  ProviderAccountStatus,
} from "../api/providerAccounts";
import {
  canUseAccountReset,
  holdResetOperation,
  resetOperation,
  resetTokenRows,
  settleResetOperation,
} from "./resetTokens";

const now = 1_800_000_000_000;
const status: ProviderAccountStatus = {
  accountId: "first",
  providerId: "codex-acp",
  state: "ready",
  subscription: null,
  accountLabel: null,
  limits: [],
  resetTokens: null,
  credits: null,
  lastUpdatedAt: now,
  lastAttemptAt: now,
  stale: false,
  error: null,
};

function credit(
  id: string,
  patch: Partial<ProviderAccountResetCredit> = {},
): ProviderAccountResetCredit {
  return {
    id,
    resetType: "full",
    status: "available",
    usesLeft: 1,
    grantedAt: null,
    expiresAt: now + 86_400_000,
    title: null,
    description: null,
    ...patch,
  };
}

function withCredits(
  credits: ProviderAccountResetCredit[],
  patch: Partial<ProviderAccountStatus> = {},
): ProviderAccountStatus {
  return {
    ...status,
    resetTokens: { available: 1, supported: true, expiresAt: null, credits },
    ...patch,
  };
}

describe("reset tokens", () => {
  it("never turns missing inventory into permission to spend a reset token", () => {
    expect(canUseAccountReset(status, now)).toBe(false);
    expect(resetTokenRows(status, now)).toEqual([]);
    expect(resetTokenRows(undefined, now)).toEqual([]);
    expect(
      canUseAccountReset(
        {
          ...status,
          resetTokens: { available: 3, supported: false, expiresAt: null },
        },
        now,
      ),
    ).toBe(false);
  });

  it("requires fresh supported unexpired inventory for an aggregate reset count", () => {
    const available = {
      ...status,
      resetTokens: { available: 2, supported: true, expiresAt: now + 1000 },
    };
    expect(canUseAccountReset(available, now)).toBe(true);
    // The count is one row; the provider picks the credit, so none is pinned.
    expect(resetTokenRows(available, now)).toEqual([
      {
        kind: "usage",
        count: 2,
        state: "available",
        blocked: null,
        expiresAt: now + 1000,
        title: null,
        description: null,
      },
    ]);
    expect(canUseAccountReset({ ...available, stale: true }, now)).toBe(false);
    expect(canUseAccountReset({ ...available, state: "error" }, now)).toBe(
      false,
    );
    expect(canUseAccountReset(available, now + 1001)).toBe(false);
    // Out-of-date counts stay listed; they are only not offered.
    expect(
      resetTokenRows({ ...available, stale: true }, now).map(
        (row) => row.state,
      ),
    ).toEqual(["unavailable"]);
    expect(
      resetTokenRows(
        {
          ...status,
          resetTokens: { available: 0, supported: true, expiresAt: null },
        },
        now,
      ),
    ).toEqual([]);
  });

  it("checks individual reset expiry without letting an old grant hide a usable one", () => {
    const available = withCredits([
      credit("old", { expiresAt: now - 1 }),
      credit("current", { expiresAt: now + 1000 }),
    ]);
    expect(canUseAccountReset(available, now)).toBe(true);
    expect(resetTokenRows(available, now)).toMatchObject([
      { kind: "full", count: 1, creditId: "current", expiresAt: now + 1000 },
    ]);
    expect(canUseAccountReset(available, now + 1000)).toBe(false);
    expect(resetTokenRows(available, now + 1000)).toEqual([]);
    expect(canUseAccountReset({ ...available, state: "needs_auth" }, now)).toBe(
      false,
    );
    expect(canUseAccountReset({ ...available, stale: true }, now)).toBe(true);
    expect(
      canUseAccountReset({ ...available, state: "error", stale: true }, now),
    ).toBe(true);
    for (const state of ["needs_auth", "disabled", "unknown"] as const)
      expect(canUseAccountReset({ ...available, state }, now)).toBe(false);
    expect(canUseAccountReset(withCredits([credit("")]), now)).toBe(false);
  });

  it("lists one row per kind and leaves spent and expired resets out", () => {
    const rows = resetTokenRows(
      withCredits([
        credit("weekly", { resetType: "weekly", expiresAt: now + 5000 }),
        credit("weekly-spent", {
          resetType: "weekly",
          status: "used",
          usesLeft: 0,
        }),
        credit("fable-first", {
          resetType: "fable",
          expiresAt: now + 9000,
          description: "Launch gift",
        }),
        credit("fable-second", {
          resetType: "fable",
          status: "queued",
          expiresAt: now + 7000,
        }),
        credit("session-lapsed", { resetType: "five_hour", status: "expired" }),
        credit("usage", { resetType: "usage", title: "Usage limit reset" }),
      ]),
      now,
    );
    expect(rows).toEqual([
      {
        kind: "weekly",
        count: 1,
        state: "available",
        blocked: null,
        creditId: "weekly",
        expiresAt: now + 5000,
        title: null,
        description: null,
      },
      {
        kind: "fable",
        // Both Fable resets count; Use redeems the one the provider takes
        // first, and the row shows that one's expiry.
        count: 2,
        state: "available",
        blocked: null,
        creditId: "fable-first",
        expiresAt: now + 9000,
        title: null,
        description: "Launch gift",
      },
      {
        kind: "usage",
        count: 1,
        state: "available",
        blocked: null,
        creditId: "usage",
        expiresAt: now + 86_400_000,
        title: "Usage limit reset",
        description: null,
      },
    ]);
  });

  it("offers every kind that can be used, not only one reset of the account", () => {
    const rows = resetTokenRows(
      withCredits([
        credit("weekly", { resetType: "weekly" }),
        credit("fable", { resetType: "fable" }),
      ]),
      now,
    );
    expect(rows.map((row) => [row.kind, row.state, row.creditId])).toEqual([
      ["weekly", "available", "weekly"],
      ["fable", "available", "fable"],
    ]);
  });

  it("counts every use left and says why a kind cannot be used now", () => {
    const held = (patch: Partial<ProviderAccountResetCredit>) =>
      resetTokenRows(withCredits([credit("grant", patch)]), now)[0];
    expect(held({ usesLeft: 3 })).toMatchObject({
      count: 3,
      creditId: "grant",
    });
    expect(
      held({ status: "unavailable", blocked: "needs_limit" }),
    ).toMatchObject({ state: "unavailable", blocked: "needs_limit" });
    expect(held({ status: "unavailable" })).toMatchObject({
      state: "unavailable",
      blocked: null,
    });
    expect(held({ status: "paused" }).state).toBe("paused");
    expect(held({ status: "redeeming" }).state).toBe("redeeming");
    // A reset whose period has not begun is listed, not offered.
    expect(held({ grantedAt: now + 1 })).toMatchObject({
      state: "unavailable",
      blocked: "not_started",
    });
    for (const row of [
      held({ status: "unavailable" }),
      held({ status: "paused" }),
      held({ status: "queued" }),
    ])
      expect(row.creditId).toBeUndefined();
    expect(
      canUseAccountReset(
        withCredits([credit("grant", { status: "queued" })]),
        now,
      ),
    ).toBe(false);
    // A redemption under way holds the other resets of its kind.
    expect(
      resetTokenRows(
        withCredits([
          credit("ready"),
          credit("in-flight", { status: "redeeming" }),
        ]),
        now,
      ),
    ).toMatchObject([{ count: 2, state: "redeeming" }]);
    // Held resets show the soonest deadline among them.
    expect(
      resetTokenRows(
        withCredits([
          credit("later", { status: "unavailable", expiresAt: now + 9000 }),
          credit("sooner", { status: "unavailable", expiresAt: now + 4000 }),
          credit("open", { status: "unavailable", expiresAt: null }),
        ]),
        now,
      )[0],
    ).toMatchObject({ count: 3, expiresAt: now + 4000 });
  });

  it("repeats an unconfirmed redemption instead of starting another", () => {
    const first = resetOperation("account", "grant", now);
    expect(first.retried).toBe(false);
    // Nothing is kept until a try ends without the provider's answer.
    expect(resetOperation("account", "grant", now).key).not.toBe(first.key);
    holdResetOperation("account", "grant", first.key, now);
    expect(resetOperation("account", "grant", now + 60_000)).toEqual({
      key: first.key,
      retried: true,
    });
    // Another reset, another account and a count without credits are apart.
    expect(resetOperation("account", "other", now).retried).toBe(false);
    expect(resetOperation("second", "grant", now).retried).toBe(false);
    expect(resetOperation("account", undefined, now).retried).toBe(false);
    // The ten minutes run from the first unconfirmed try.
    holdResetOperation("account", "grant", first.key, now + 9 * 60_000);
    expect(resetOperation("account", "grant", now + 10 * 60_000).retried).toBe(
      false,
    );
    holdResetOperation("account", "grant", first.key, now);
    settleResetOperation("account", "grant");
    expect(resetOperation("account", "grant", now).retried).toBe(false);
  });
});
