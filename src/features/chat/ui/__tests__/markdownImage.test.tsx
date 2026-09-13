import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownImage } from "../MarkdownImage";

const mocks = vi.hoisted(() => ({
  resolveMarkdownHref: vi.fn(),
  pathExists: vi.fn<(path: string) => Promise<boolean>>(),
  isPathWithinTrustedRoots: vi.fn<(path: string) => boolean>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme: string) => `${scheme}://${path}`,
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: mocks.resolveMarkdownHref,
    pathExists: mocks.pathExists,
    isPathWithinTrustedRoots: mocks.isPathWithinTrustedRoots,
  }),
}));

vi.mock("@/features/chat/ui/ClickableImage", () => ({
  ClickableImage: ({ src, alt }: { src: string; alt: string }) => (
    <img data-testid="clickable-image" src={src} alt={alt} />
  ),
}));

describe("MarkdownImage", () => {
  beforeEach(() => {
    mocks.resolveMarkdownHref.mockReset();
    mocks.pathExists.mockReset();
    mocks.isPathWithinTrustedRoots.mockReset();
    mocks.isPathWithinTrustedRoots.mockReturnValue(false);
  });

  it("renders an eligible local image via the asset: scheme by default", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./puppy.jpg",
      resolvedPath: "/work/puppy.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./puppy.jpg" alt="puppy" />);

    const img = await screen.findByTestId("clickable-image");
    expect(img.getAttribute("src")).toBe("asset:///work/puppy.jpg");
    expect(img.getAttribute("alt")).toBe("puppy");
    expect(mocks.pathExists).toHaveBeenCalledWith("/work/puppy.jpg");
  });

  it("does not rescue a remote https image (CSP handles it)", () => {
    render(<MarkdownImage src="https://example.com/p.jpg" alt="remote" />);

    expect(screen.getByAltText("remote").getAttribute("src")).toBe(
      "https://example.com/p.jpg",
    );
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    // Remote sources short-circuit before touching the policy context.
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it.each([
    ["data:image/png;base64,abc", "data"],
    ["blob:https://example.com/image-id", "blob"],
  ])("leaves %s sources to the browser", (src, alt) => {
    render(<MarkdownImage src={src} alt={alt} />);

    expect(screen.getByAltText(alt).getAttribute("src")).toBe(src);
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it("falls back to a plain <img> when the local file does not exist", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./missing.jpg",
      resolvedPath: "/work/missing.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(false);

    render(<MarkdownImage src="./missing.jpg" alt="missing" />);

    await waitFor(() => {
      expect(mocks.pathExists).toHaveBeenCalledWith("/work/missing.jpg");
    });
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("missing").getAttribute("src")).toBe(
      "./missing.jpg",
    );
  });

  it("does not rescue a resolved path that is not an image extension", () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./notes.txt",
      resolvedPath: "/work/notes.txt",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./notes.txt" alt="notes" />);

    // Non-image extension is rejected before any existence check.
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("notes").getAttribute("src")).toBe(
      "./notes.txt",
    );
  });

  it("does not rescue when the policy context blocks the scheme", () => {
    mocks.resolveMarkdownHref.mockReturnValue(null);

    render(<MarkdownImage src="weird:thing" alt="blocked" />);

    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("blocked").getAttribute("src")).toBe(
      "weird:thing",
    );
  });

  it("does not rescue a path resolved outside the session cwd", () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "../../secret.png",
      resolvedPath: "/secret.png",
      isWithinSessionCwd: false,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="../../secret.png" alt="escape" />);

    // Out-of-cwd paths are rejected before any existence check, including
    // absolute paths and paths that escape with `..`.
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("escape").getAttribute("src")).toBe(
      "../../secret.png",
    );
  });

  it("clears the stale image when src switches to a new local image", async () => {
    mocks.resolveMarkdownHref.mockImplementation((href: string) => ({
      rawPath: href,
      resolvedPath: `/work/${href}`,
      isWithinSessionCwd: true,
    }));
    // First image resolves immediately; second stays pending so the stale
    // first image can be checked while the new existence check is in flight.
    let resolveSecond: ((value: boolean) => void) | undefined;
    mocks.pathExists.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const { rerender } = render(<MarkdownImage src="a.png" alt="first" />);
    const first = await screen.findByTestId("clickable-image");
    expect(first.getAttribute("src")).toBe("asset:///work/a.png");

    rerender(<MarkdownImage src="b.png" alt="second" />);

    await waitFor(() => {
      expect(screen.queryByTestId("clickable-image")).toBeNull();
    });

    resolveSecond?.(true);
    const second = await screen.findByTestId("clickable-image");
    expect(second.getAttribute("src")).toBe("asset:///work/b.png");
  });

  it("falls back to a plain <img> when the existence check rejects", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./boom.png",
      resolvedPath: "/work/boom.png",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockRejectedValue(new Error("boom"));

    render(<MarkdownImage src="./boom.png" alt="boom" />);

    await waitFor(() => {
      expect(mocks.pathExists).toHaveBeenCalledWith("/work/boom.png");
    });
    // A rejection must not leave a stale image or surface as unhandled.
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("boom").getAttribute("src")).toBe("./boom.png");
  });

  // `http://asset.localhost/<encoded path>` names a local file while looking
  // remote. Markdown can spell one directly, and the asset scope the webview
  // enforces covers all of $HOME, so it gets the same scoping as `./photo.png`
  // instead of being passed to the browser as a remote URL.
  describe("asset: URLs in Markdown", () => {
    const privateAssetSrc =
      "http://asset.localhost/C%3A%2FUsers%2Fme%2FPictures%2Fprivate.png";
    const workAssetSrc = "http://asset.localhost/C%3A%2Fwork%2Fdiagram.png";

    it("renders nothing for an asset url outside the chat's folders", () => {
      mocks.isPathWithinTrustedRoots.mockReturnValue(false);
      mocks.pathExists.mockResolvedValue(true);

      const { container } = render(
        <MarkdownImage src={privateAssetSrc} alt="private" />,
      );

      expect(mocks.isPathWithinTrustedRoots).toHaveBeenCalledWith(
        "C:/Users/me/Pictures/private.png",
      );
      // Neither the rescued image nor a plain <img> that the webview would
      // fetch anyway.
      expect(screen.queryByTestId("clickable-image")).toBeNull();
      expect(container.querySelector("img")).toBeNull();
      expect(mocks.pathExists).not.toHaveBeenCalled();
      // The asset URL is local, so it never goes through the Markdown-href
      // resolution used for relative destinations.
      expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
    });

    it("renders an asset url inside the chat's folders", async () => {
      mocks.isPathWithinTrustedRoots.mockReturnValue(true);
      mocks.pathExists.mockResolvedValue(true);

      render(<MarkdownImage src={workAssetSrc} alt="diagram" />);

      const img = await screen.findByTestId("clickable-image");
      expect(img.getAttribute("src")).toBe("asset://C:/work/diagram.png");
      expect(mocks.pathExists).toHaveBeenCalledWith("C:/work/diagram.png");
    });

    it("renders nothing for an allowed asset url whose file is gone", async () => {
      mocks.isPathWithinTrustedRoots.mockReturnValue(true);
      mocks.pathExists.mockResolvedValue(false);

      const { container } = render(
        <MarkdownImage src={workAssetSrc} alt="diagram" />,
      );

      await waitFor(() => {
        expect(mocks.pathExists).toHaveBeenCalledWith("C:/work/diagram.png");
      });
      expect(screen.queryByTestId("clickable-image")).toBeNull();
      expect(container.querySelector("img")).toBeNull();
    });
  });
});
