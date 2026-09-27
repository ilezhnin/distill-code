import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractToolResultImages,
  hydrateToolResultImages,
} from "../acpToolCallContent";

const mocks = vi.hoisted(() => ({
  readImageAttachment: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  readImageAttachment: mocks.readImageAttachment,
}));

describe("extractToolResultImages", () => {
  it("keeps ACP image content blocks", () => {
    expect(
      extractToolResultImages({
        content: [
          {
            type: "content",
            content: {
              type: "image",
              data: "abc",
              mimeType: "image/png",
            },
          },
        ],
      }),
    ).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
  });

  it("promotes a Grok image_gen rawOutput path", () => {
    const path = "C:\\Users\\User\\.grok\\sessions\\cwd\\images\\1.jpg";
    expect(
      extractToolResultImages({
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({
                path,
                filename: "1.jpg",
                session_folder: "images",
              }),
            },
          },
        ],
        rawOutput: {
          type: "ImageGen",
          path,
          filename: "1.jpg",
          session_folder: "images",
        },
      }),
    ).toEqual([{ type: "image", mimeType: "image/jpeg", uri: path }]);
  });

  it("ignores relative and non-image paths", () => {
    expect(
      extractToolResultImages({
        content: [
          {
            type: "content",
            content: { type: "text", text: '{"path":"images/1.jpg"}' },
          },
        ],
        rawOutput: { path: "/tmp/notes.md" },
      }),
    ).toEqual([]);
  });
});

describe("hydrateToolResultImages", () => {
  beforeEach(() => {
    mocks.readImageAttachment.mockReset();
  });

  it("passes through images that already have bytes", async () => {
    await expect(
      hydrateToolResultImages([
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
    ).resolves.toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
    expect(mocks.readImageAttachment).not.toHaveBeenCalled();
  });

  it("reads local tool output paths into inline bytes", async () => {
    mocks.readImageAttachment.mockResolvedValue({
      base64: "Zm9v",
      mimeType: "image/jpeg",
    });

    await expect(
      hydrateToolResultImages([
        {
          type: "image",
          mimeType: "image/jpeg",
          uri: "C:\\Users\\User\\.grok\\sessions\\cwd\\images\\1.jpg",
        },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        mimeType: "image/jpeg",
        uri: "C:\\Users\\User\\.grok\\sessions\\cwd\\images\\1.jpg",
        data: "Zm9v",
      },
    ]);
    expect(mocks.readImageAttachment).toHaveBeenCalledWith(
      "C:\\Users\\User\\.grok\\sessions\\cwd\\images\\1.jpg",
    );
  });

  it("drops paths that cannot be read", async () => {
    mocks.readImageAttachment.mockRejectedValue(new Error("missing"));
    await expect(
      hydrateToolResultImages([
        { type: "image", mimeType: "image/png", uri: "/tmp/missing.png" },
      ]),
    ).resolves.toEqual([]);
  });
});
