import type { SessionCostBilling } from "@/shared/types/chat";

export type { SessionCostBilling };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * ACP `usage_update.cost` is list-price USD unless the bridge marks it billed.
 * Distill never infers invoices from currency or a subscription bar.
 */
export function sessionCostBillingForAmount(
  amount: number | null | undefined,
  billed?: boolean | null,
): SessionCostBilling | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return null;
  }
  return billed === true ? "billed" : "estimate";
}

export function readUsageCostBilledFlag(cost: unknown): boolean | undefined {
  if (!isRecord(cost) || !isRecord(cost._meta)) {
    return undefined;
  }
  const distill = isRecord(cost._meta.distill) ? cost._meta.distill : null;
  const raw = distill?.billed ?? cost._meta.billed;
  return typeof raw === "boolean" ? raw : undefined;
}
