import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuildFeatureState } from "./buildProfile";

describe("buildProfile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults every opt-in build feature off", () => {
    expect(getBuildFeatureState()).toEqual({ securityMl: false });
  });

  it("enables security ML only when VITE_SECURITY_ML is set to 1", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SECURITY_ML", "1");
    const { getBuildFeatureState: enabled } = await import("./buildProfile");
    expect(enabled().securityMl).toBe(true);

    vi.resetModules();
    vi.stubEnv("VITE_SECURITY_ML", "true");
    const { getBuildFeatureState: disabled } = await import("./buildProfile");
    expect(disabled().securityMl).toBe(false);
  });
});
