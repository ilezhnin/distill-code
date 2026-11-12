import type {
  ProviderAccountResetBlock,
  ProviderAccountResetCredit,
  ProviderAccountResetKind,
  ProviderAccountStatus,
} from "../api/providerAccounts";
import {
  accountIsConnected,
  accountStatusIsStale,
} from "./providerAccountStatus";

/** The order reset kinds are listed in, the narrowest first. */
const KIND_ORDER: readonly ProviderAccountResetKind[] = [
  "five_hour",
  "weekly",
  "fable",
  "full",
  "usage",
];

/**
 * One line of an account's reset tokens: every reset of one kind that can
 * still be used, and the one a Use action redeems.
 */
export interface ResetTokenRow {
  kind: ProviderAccountResetKind;
  /** Redemptions left across the kind's resets. */
  count: number;
  state: "available" | "redeeming" | "paused" | "unavailable";
  /** Why none of the kind can be used now, when the provider says. */
  blocked: ProviderAccountResetBlock | null;
  /**
   * The credit a Use action redeems. Absent when the provider reports a
   * count without its credits and picks one itself.
   */
  creditId?: string;
  expiresAt: number | null;
  /** The provider's own name and words for the reset, when it gives them. */
  title: string | null;
  description: string | null;
}

export function resetCreditIsAvailable(
  credit: ProviderAccountResetCredit,
  now = Date.now(),
): boolean {
  return (
    credit.id.trim().length > 0 &&
    credit.status === "available" &&
    (credit.grantedAt === null || credit.grantedAt <= now) &&
    (credit.expiresAt === null || credit.expiresAt > now)
  );
}

/** A credit that can still be used, now or later. */
function resetCreditIsLive(
  credit: ProviderAccountResetCredit,
  now: number,
): boolean {
  return (
    credit.status !== "used" &&
    credit.status !== "expired" &&
    credit.usesLeft > 0 &&
    (credit.expiresAt === null || credit.expiresAt > now)
  );
}

function kindRow(
  kind: ProviderAccountResetKind,
  credits: ProviderAccountResetCredit[],
  now: number,
): ResetTokenRow {
  // A redemption under way holds the whole kind: another reset started
  // beside it could spend two where one was meant.
  const redeeming = credits.find((credit) => credit.status === "redeeming");
  // The provider's order decides which reset of a kind goes first.
  const target = redeeming
    ? undefined
    : credits.find((credit) => resetCreditIsAvailable(credit, now));
  const shown = target ?? redeeming ?? credits[0];
  const deadlines = credits.flatMap((credit) => credit.expiresAt ?? []);
  const notStarted = shown.grantedAt !== null && shown.grantedAt > now;
  return {
    kind,
    count: credits.reduce((sum, credit) => sum + credit.usesLeft, 0),
    state: target
      ? "available"
      : shown.status === "redeeming" || shown.status === "paused"
        ? shown.status
        : "unavailable",
    blocked: target
      ? null
      : (shown.blocked ?? (notStarted ? "not_started" : null)),
    ...(target ? { creditId: target.id } : {}),
    expiresAt: target
      ? target.expiresAt
      : deadlines.length
        ? Math.min(...deadlines)
        : null,
    title: shown.title,
    description: shown.description,
  };
}

/**
 * An account's reset tokens as its card lists them, for every provider: one
 * row per kind, without the resets that are spent or expired.
 */
export function resetTokenRows(
  status: ProviderAccountStatus | undefined,
  now = Date.now(),
): ResetTokenRow[] {
  const inventory = status?.resetTokens;
  if (!status || !inventory) return [];
  if (!inventory.credits?.length) {
    if (inventory.available <= 0) return [];
    // A count cannot pin a credit, so spending one needs current data.
    const current =
      !accountStatusIsStale(status, now) &&
      status.state !== "error" &&
      (inventory.expiresAt === null || inventory.expiresAt > now);
    return [
      {
        kind: "usage",
        count: inventory.available,
        state: current ? "available" : "unavailable",
        blocked: null,
        expiresAt: inventory.expiresAt,
        title: null,
        description: null,
      },
    ];
  }
  const live = inventory.credits.filter((credit) =>
    resetCreditIsLive(credit, now),
  );
  return KIND_ORDER.flatMap((kind) => {
    const credits = live.filter((credit) => credit.resetType === kind);
    return credits.length ? [kindRow(kind, credits, now)] : [];
  });
}

export function canUseAccountReset(
  status: ProviderAccountStatus | undefined,
  now = Date.now(),
): boolean {
  // A listed credit stays selectable during a telemetry outage: confirmation
  // pins its ID, and the provider validates that exact credit on redemption.
  return (
    Boolean(status?.resetTokens?.supported) &&
    accountIsConnected(status) &&
    resetTokenRows(status, now).some((row) => row.state === "available")
  );
}

/**
 * How long a redemption the provider did not confirm keeps its operation key,
 * as the native CLI keeps it: a second try of the same reset within this time
 * repeats the first try instead of spending another reset.
 */
const UNSETTLED_RESET_MS = 10 * 60_000;

const unsettledResets = new Map<string, { key: string; at: number }>();

function operationId(accountId: string, creditId: string | undefined) {
  return `${accountId}\n${creditId ?? ""}`;
}

/**
 * The operation key for redeeming a reset: the key of an earlier try the
 * provider did not confirm, or a new one.
 */
export function resetOperation(
  accountId: string,
  creditId: string | undefined,
  now = Date.now(),
): { key: string; retried: boolean } {
  const id = operationId(accountId, creditId);
  const earlier = unsettledResets.get(id);
  if (earlier && now - earlier.at < UNSETTLED_RESET_MS)
    return { key: earlier.key, retried: true };
  unsettledResets.delete(id);
  return { key: crypto.randomUUID(), retried: false };
}

/** Keeps the key of a redemption that ended without the provider's answer. */
export function holdResetOperation(
  accountId: string,
  creditId: string | undefined,
  key: string,
  now = Date.now(),
) {
  const id = operationId(accountId, creditId);
  // The time runs from the first unconfirmed try of this key.
  if (unsettledResets.get(id)?.key !== key)
    unsettledResets.set(id, { key, at: now });
}

/** Gives up the key of a redemption the provider has answered. */
export function settleResetOperation(
  accountId: string,
  creditId: string | undefined,
) {
  unsettledResets.delete(operationId(accountId, creditId));
}
