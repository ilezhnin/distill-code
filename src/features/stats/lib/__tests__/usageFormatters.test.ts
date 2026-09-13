import { describe, expect, it } from "vitest";
import { formatUsageCost } from "../usageFormatters";

describe("formatUsageCost", () => {
  it("shows dollars when the currency is unknown or USD", () => {
    expect(formatUsageCost(12.3456, "n/a")).toBe("$12.35");
    expect(formatUsageCost(12.3456, "n/a", "usd")).toBe("$12.35");
    expect(formatUsageCost(0.001, "n/a")).toBe("<$0.01");
    expect(formatUsageCost(null, "n/a")).toBe("n/a");
  });

  it("formats a known currency in its own unit", () => {
    const formatted = formatUsageCost(12.3456, "n/a", "EUR");
    expect(formatted).not.toContain("$");
    expect(formatted).toMatch(/12[.,]35/);
  });

  it("shows an unusual unit as an amount plus its label", () => {
    expect(formatUsageCost(120, "n/a", "credits")).toBe("120.00 CREDITS");
  });
});
