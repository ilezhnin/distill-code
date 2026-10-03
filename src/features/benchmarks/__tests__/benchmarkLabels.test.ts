import { describe, expect, it } from "vitest";
import { formatElapsed } from "../lib/benchmarkLabels";

describe("formatElapsed", () => {
  const t = ((key: string, options?: { count?: number }) =>
    ({
      "elapsed.seconds": `${options?.count} s`,
      "elapsed.minutes": `${options?.count} min`,
      "elapsed.hours": `${options?.count} h`,
      "elapsed.days": `${options?.count} days`,
      unknown: "Not reported",
    })[key] ?? key) as Parameters<typeof formatElapsed>[0];

  it("reads in the largest unit that still carries the remainder", () => {
    expect(formatElapsed(t, null)).toBe("Not reported");
    expect(formatElapsed(t, 42_400)).toBe("42 s");
    expect(formatElapsed(t, 155_000)).toBe("2 min 35 s");
    expect(formatElapsed(t, 180_000)).toBe("3 min");
    expect(formatElapsed(t, 4_320_000)).toBe("1 h 12 min");
    expect(formatElapsed(t, 183_600_000)).toBe("2 days 3 h");
  });
});
