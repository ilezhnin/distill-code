import { describe, expect, it } from "vitest";
import enCommon from "../locales/en/common.json";
import esCommon from "../locales/es/common.json";

describe("model inventory locale parity", () => {
  it("translates every empty-list explanation into Spanish", () => {
    for (const key of [
      "pollFailed",
      "pollFailedUnknown",
      "reportedNone",
    ] as const) {
      expect(esCommon.modelInventory[key]).toBeTruthy();
      expect(esCommon.modelInventory[key]).not.toBe(
        enCommon.modelInventory[key],
      );
    }
  });

  // The line exists to tell three situations apart, so it has to name the
  // provider it is talking about, and a failed poll has to carry its reason.
  it("names the provider in both locales, and the reason where there is one", () => {
    for (const copy of [enCommon.modelInventory, esCommon.modelInventory]) {
      expect(copy.pollFailed).toContain("{{provider}}");
      expect(copy.pollFailed).toContain("{{reason}}");
      expect(copy.pollFailedUnknown).toContain("{{provider}}");
      expect(copy.reportedNone).toContain("{{provider}}");
    }
  });
});
