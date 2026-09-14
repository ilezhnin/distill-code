import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useZoom } from "../useZoom";

describe("useZoom with blocked storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.documentElement.style.removeProperty("--goose-content-zoom");
  });

  it("falls back to the default zoom instead of throwing", () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => renderHook(() => useZoom())).not.toThrow();
    expect(
      document.documentElement.style.getPropertyValue("--goose-content-zoom"),
    ).toBe("1");
  });
});
