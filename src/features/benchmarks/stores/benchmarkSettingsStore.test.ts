import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIME_LIMIT_MINUTES,
  normalizeCreditLimit,
  parseBenchmarkSettings,
} from "./benchmarkSettingsStore";

describe("benchmark settings", () => {
  it("keeps credits off until a limit is stored", () => {
    expect(parseBenchmarkSettings({ timeLimitMinutes: 90 })).toEqual({
      timeLimitMinutes: 90,
      creditLimit: null,
    });
    expect(parseBenchmarkSettings(null)).toEqual({
      timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
      creditLimit: null,
    });
    for (const stored of ["500", -1, Number.NaN, null]) {
      expect(parseBenchmarkSettings({ creditLimit: stored }).creditLimit).toBe(
        null,
      );
    }
  });

  it("stores a limit as whole credits, zero included", () => {
    expect(parseBenchmarkSettings({ creditLimit: 499.6 }).creditLimit).toBe(
      500,
    );
    expect(normalizeCreditLimit(0)).toBe(0);
    expect(normalizeCreditLimit(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
