import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `asset://localhost/${scheme ?? "asset"}${path}`,
}));

import { resolveImageContentSrc } from "../resolveImageContentSrc";

describe("resolveImageContentSrc", () => {
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
});

describe("resolveImageContentSrc local scoping", () => {
  const allowOnly = (allowed: string) => (path: string) => path === allowed;

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
});
