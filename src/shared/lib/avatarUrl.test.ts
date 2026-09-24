import { describe, expect, it } from "vitest";
import {
  isSafePngAvatarDataUrl,
  normalizeAvatarUrl,
  resolveAvatarSrc,
} from "./avatarUrl";

describe("avatarUrl", () => {
  it("accepts only bounded, structurally valid PNG data URLs", () => {
    const value =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
    expect(isSafePngAvatarDataUrl(value)).toBe(true);
    expect(normalizeAvatarUrl(value)).toBe(value);
    expect(resolveAvatarSrc(value)).toBe(value);
    expect(isSafePngAvatarDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      false,
    );
    expect(isSafePngAvatarDataUrl("data:image/png;base64,aWNvbg==")).toBe(
      false,
    );
    expect(isSafePngAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(
      false,
    );
  });

  it("rejects unsafe avatar URL schemes and credentials", () => {
    expect(normalizeAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeAvatarUrl("file:///tmp/avatar.png")).toBeUndefined();
    expect(
      normalizeAvatarUrl("data:image/png;base64,aWNvbg=="),
    ).toBeUndefined();
    expect(normalizeAvatarUrl("https://")).toBeUndefined();
    expect(
      normalizeAvatarUrl("https://user:pass@example.test/avatar.png"),
    ).toBeUndefined();
  });

  it("rejects local paths and traversal-like strings", () => {
    expect(normalizeAvatarUrl("/tmp/avatar.png")).toBeUndefined();
    expect(normalizeAvatarUrl("C:\\tmp\\avatar.png")).toBeUndefined();
    expect(normalizeAvatarUrl("../avatar.png")).toBeUndefined();
    expect(
      normalizeAvatarUrl("https://example.test/../avatar.png"),
    ).toBeUndefined();
    expect(
      normalizeAvatarUrl("https://example.test/%2e%2e/avatar.png"),
    ).toBeUndefined();
    expect(normalizeAvatarUrl("gloopy-1.png")).toBeUndefined();
  });
});
