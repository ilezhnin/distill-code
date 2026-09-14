import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `asset://localhost/${scheme ?? "asset"}${path}`,
}));

import {
  assetUrlToPath,
  resolveImageContentSrc,
} from "../resolveImageContentSrc";

describe("resolveImageContentSrc", () => {
  it("prefers inline base64 data over a file:// uri", () => {
    const src = resolveImageContentSrc({
      data: "AAAA",
      mimeType: "image/png",
      uri: "file:///tmp/generated.png",
    });
    expect(src).toBe("data:image/png;base64,AAAA");
  });

  it("falls back to image/png when mimeType is missing", () => {
    const src = resolveImageContentSrc({ data: "AAAA" });
    expect(src).toBe("data:image/png;base64,AAAA");
  });

  it("routes a local file:// uri through the asset scheme when no data", () => {
    const src = resolveImageContentSrc({
      data: "",
      uri: "file:///tmp/with%20space.png",
    });
    expect(src).toBe("asset://localhost/asset/tmp/with space.png");
  });

  it.each([
    ["file:generated.png"],
    ["file:./generated.png"],
    ["file:///tmp/bad%ZZ.png"],
    ["file:///tmp/report.png?download=1"],
    ["file:///tmp/report.png#preview"],
    ["file://user@server/share/report.png"],
  ])("rejects an unsafe file uri %s", (uri) => {
    expect(resolveImageContentSrc({ data: "", uri })).toBeNull();
  });

  it("passes through a remote uri verbatim when no data", () => {
    const src = resolveImageContentSrc({
      data: "",
      uri: "https://example.com/a.png",
    });
    expect(src).toBe("https://example.com/a.png");
  });

  it("returns null when there is nothing renderable", () => {
    expect(resolveImageContentSrc({ data: "", uri: "" })).toBeNull();
    expect(resolveImageContentSrc({})).toBeNull();
  });
});

describe("resolveImageContentSrc local scoping", () => {
  const allowOnly = (allowed: string) => (path: string) => path === allowed;

  it("renders a file:// uri inside the chat's folders", () => {
    const src = resolveImageContentSrc(
      { data: "", uri: "file:///work/repo/diagram.png" },
      allowOnly("/work/repo/diagram.png"),
    );
    expect(src).toBe("asset://localhost/asset/work/repo/diagram.png");
  });

  it("rejects a file:// uri outside the chat's folders", () => {
    // An image block's uri is agent-supplied; the asset scope covers all of
    // $HOME, so without this check any picture there could be displayed.
    expect(
      resolveImageContentSrc(
        { data: "", uri: "file:///Users/me/Pictures/private.png" },
        allowOnly("/work/repo/diagram.png"),
      ),
    ).toBeNull();
  });

  it.each([
    "http://asset.localhost/C%3A%2FUsers%2Fme%2FPictures%2Fprivate.png",
    "asset://localhost/C%3A%2FUsers%2Fme%2FPictures%2Fprivate.png",
  ])("rejects the asset url %s outside the chat's folders", (uri) => {
    expect(
      resolveImageContentSrc({ data: "", uri }, allowOnly("C:/work/ok.png")),
    ).toBeNull();
  });

  it("keeps an asset url inside the chat's folders verbatim", () => {
    const uri = "http://asset.localhost/C%3A%2Fwork%2Fok.png";
    expect(
      resolveImageContentSrc({ data: "", uri }, allowOnly("C:/work/ok.png")),
    ).toBe(uri);
  });

  it("leaves inline data and remote uris unscoped", () => {
    const deny = () => false;
    expect(resolveImageContentSrc({ data: "AAAA" }, deny)).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(
      resolveImageContentSrc(
        { data: "", uri: "https://example.com/a.png" },
        deny,
      ),
    ).toBe("https://example.com/a.png");
  });
});

describe("assetUrlToPath", () => {
  it.each([
    ["http://asset.localhost/C%3A%2Fwork%2Fok.png", "C:/work/ok.png"],
    ["https://asset.localhost/C%3A%2Fwork%2Fok.png", "C:/work/ok.png"],
    ["asset://localhost/%2Fwork%2Fok.png", "/work/ok.png"],
    ["http://asset.localhost/C%3A%2Fwork%2Fok.png?v=2", "C:/work/ok.png"],
  ])("decodes %s", (src, expected) => {
    expect(assetUrlToPath(src)).toBe(expected);
  });

  it.each([
    "https://example.com/a.png",
    "http://asset.localhost.evil.example/x.png",
    "http://asset.localhost/",
    "http://asset.localhost/%ZZ",
    "./photo.png",
  ])("does not treat %s as an asset url", (src) => {
    expect(assetUrlToPath(src)).toBeNull();
  });
});
