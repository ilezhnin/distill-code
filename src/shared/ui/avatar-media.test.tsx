import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvatarMedia, avatarImageSrc } from "./avatar-media";

describe("AvatarMedia", () => {
  it("renders image avatars, including gif", () => {
    render(
      <AvatarMedia
        media={{ src: "asset://avatar.gif", mediaType: "image" }}
        alt="Agent"
      />,
    );

    expect(screen.getByRole("img", { name: "Agent" })).toHaveAttribute(
      "src",
      "asset://avatar.gif",
    );
    expect(document.querySelector("video")).toBeNull();
  });

  it("uses a video poster as a still image", () => {
    render(
      <AvatarMedia
        media={{
          src: "asset://avatar.webm",
          mediaType: "video",
          posterSrc: "asset://avatar.png",
        }}
        alt="Agent"
      />,
    );

    expect(screen.getByRole("img", { name: "Agent" })).toHaveAttribute(
      "src",
      "asset://avatar.png",
    );
    expect(document.querySelector("video")).toBeNull();
  });

  it("renders nothing when a video has no still", () => {
    const { container } = render(
      <AvatarMedia
        media={{ src: "asset://avatar.webm", mediaType: "video" }}
        alt="Agent"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("fires onReady when the image loads", () => {
    const onReady = vi.fn();
    render(
      <AvatarMedia
        media={{ src: "asset://avatar.png", mediaType: "image" }}
        alt="Agent"
        onReady={onReady}
      />,
    );

    fireEvent.load(screen.getByRole("img", { name: "Agent" }));
    expect(onReady).toHaveBeenCalledOnce();
  });
});

describe("avatarImageSrc", () => {
  it("prefers an explicit poster over a video source", () => {
    expect(
      avatarImageSrc(
        {
          src: "asset://avatar.webm",
          mediaType: "video",
          posterSrc: "asset://poster.png",
        },
        "asset://override.png",
      ),
    ).toBe("asset://override.png");
  });
});
