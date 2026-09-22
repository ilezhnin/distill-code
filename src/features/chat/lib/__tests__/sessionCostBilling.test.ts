import { describe, expect, it } from "vitest";
import {
  readUsageCostBilledFlag,
  sessionCostBillingForAmount,
} from "../sessionCostBilling";

describe("sessionCostBillingForAmount", () => {
  it("returns null when there is no finite amount", () => {
    expect(sessionCostBillingForAmount(null)).toBeNull();
    expect(sessionCostBillingForAmount(undefined)).toBeNull();
    expect(sessionCostBillingForAmount(Number.NaN)).toBeNull();
  });

  it("treats a reported amount as an estimate unless billed is true", () => {
    expect(sessionCostBillingForAmount(6.28)).toBe("estimate");
    expect(sessionCostBillingForAmount(6.28, false)).toBe("estimate");
    expect(sessionCostBillingForAmount(6.28, true)).toBe("billed");
  });
});

describe("readUsageCostBilledFlag", () => {
  it("reads an explicit billed flag from cost meta", () => {
    expect(
      readUsageCostBilledFlag({ amount: 1, currency: "USD" }),
    ).toBeUndefined();
    expect(
      readUsageCostBilledFlag({
        amount: 1,
        currency: "USD",
        _meta: { billed: true },
      }),
    ).toBe(true);
    expect(
      readUsageCostBilledFlag({
        amount: 1,
        currency: "USD",
        _meta: { distill: { billed: true } },
      }),
    ).toBe(true);
    expect(
      readUsageCostBilledFlag({
        amount: 1,
        currency: "USD",
        _meta: { billed: false },
      }),
    ).toBe(false);
  });
});
