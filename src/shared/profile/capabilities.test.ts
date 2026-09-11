import { describe, expect, it } from "vitest";
import { resolveProfileCapabilities } from "./capabilities";

describe("resolveProfileCapabilities", () => {
  it("keeps doctor on until runtime config says otherwise", () => {
    expect(
      resolveProfileCapabilities({
        runtimeConfig: null,
        runtimeConfigLoaded: false,
      }),
    ).toEqual({ doctor: true });
    expect(
      resolveProfileCapabilities({
        runtimeConfig: { schemaVersion: 1, doctor: { enabled: false } },
        runtimeConfigLoaded: true,
      }),
    ).toEqual({ doctor: false });
    expect(
      resolveProfileCapabilities({
        runtimeConfig: { schemaVersion: 1 },
        runtimeConfigLoaded: true,
      }),
    ).toEqual({ doctor: true });
  });
});
