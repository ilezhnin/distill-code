import { describe, expect, it } from "vitest";

import { formatBrigadeChipReason } from "../useBrigadeChipSummary";

const t = (key: string) => key;

describe("formatBrigadeChipReason", () => {
  it("says a provider turned the requests away in plain words", () => {
    expect(
      formatBrigadeChipReason(
        "exceeded retry limit, last status: 429 Too Many Requests",
        t,
      ),
    ).toBe("conductor.chip.rateLimited");
    expect(formatBrigadeChipReason("Too many requests", t)).toBe(
      "conductor.chip.rateLimited",
    );
  });

  it("keeps every other reason as the host gave it", () => {
    expect(formatBrigadeChipReason("The sandbox could not start", t)).toBe(
      "The sandbox could not start",
    );
    expect(formatBrigadeChipReason("Wrote 4290 rows", t)).toBe(
      "Wrote 4290 rows",
    );
    expect(formatBrigadeChipReason(undefined, t)).toBeUndefined();
  });
});
