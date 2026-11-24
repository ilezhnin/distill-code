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
    const path = "C:\\Users\\Example\\.grok\\sessions\\cwd\\images\\1.jpg";
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

  // What a tool answers is text someone else wrote. A path in it that names a
  // server would have the machine connect there as soon as the file is read.
  it.each([
    ["\\\\192.0.2.10\\share\\a.png"],
    ["//192.0.2.10/share/a.png"],
    ["/\\192.0.2.10\\share\\a.png"],
    ["\\/192.0.2.10/share/a.png"],
    ["/%5C192.0.2.10%5Cshare%5Ca.png"],
    ["%5C%5C192.0.2.10%5Cshare%5Ca.png"],
    ["\\\\?\\UNC\\192.0.2.10\\share\\a.png"],
    ["//?/UNC/192.0.2.10/share/a.png"],
    ["\\\\.\\UNC\\192.0.2.10\\share\\a.png"],
    ["\\??\\UNC\\192.0.2.10\\share\\a.png"],
    ["file://192.0.2.10/share/a.png"],
  ])("ignores the server path %s wherever the tool names it", (path) => {
    expect(
      extractToolResultImages({
        content: [
          {
            type: "content",
            content: { type: "text", text: JSON.stringify({ path }) },
          },
        ],
      }),
    ).toEqual([]);
    expect(extractToolResultImages({ rawOutput: { path } })).toEqual([]);
    expect(extractToolResultImages({ rawOutput: path })).toEqual([]);
  });

  it("still takes a local path beside a server path", () => {
    expect(
      extractToolResultImages({
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: '{"path":"/\\\\192.0.2.10\\\\share\\\\a.png"}',
            },
          },
        ],
        rawOutput: { path: "/tmp/generated/a.png" },
      }),
    ).toEqual([
      { type: "image", mimeType: "image/png", uri: "/tmp/generated/a.png" },
    ]);
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
          uri: "C:\\Users\\Example\\.grok\\sessions\\cwd\\images\\1.jpg",
        },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        mimeType: "image/jpeg",
        uri: "C:\\Users\\Example\\.grok\\sessions\\cwd\\images\\1.jpg",
        data: "Zm9v",
      },
    ]);
    expect(mocks.readImageAttachment).toHaveBeenCalledWith(
      "C:\\Users\\Example\\.grok\\sessions\\cwd\\images\\1.jpg",
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

  it("reads a local file URL as the path it names", async () => {
    mocks.readImageAttachment.mockResolvedValue({
      base64: "Zm9v",
      mimeType: "image/png",
    });

    await expect(
      hydrateToolResultImages([
        {
          type: "image",
          mimeType: "image/png",
          uri: "file:///C:/Users/Example/generated/a.png",
        },
      ]),
    ).resolves.toHaveLength(1);
    expect(mocks.readImageAttachment).toHaveBeenCalledWith(
      "C:/Users/Example/generated/a.png",
    );
  });

  // An image block's `uri` is the tool's own text too, and no spelling of a
  // server in it may reach the native read.
  it.each([
    ["\\\\192.0.2.10\\share\\a.png"],
    ["//192.0.2.10/share/a.png"],
    ["/\\192.0.2.10\\share\\a.png"],
    ["\\/192.0.2.10/share/a.png"],
    ["/%5C192.0.2.10%5Cshare%5Ca.png"],
    ["\\\\?\\UNC\\192.0.2.10\\share\\a.png"],
    ["\\\\.\\UNC\\192.0.2.10\\share\\a.png"],
    ["\\??\\UNC\\192.0.2.10\\share\\a.png"],
    ["file://192.0.2.10/share/a.png"],
    ["FILE://192.0.2.10/share/a.png"],
    ["file:////192.0.2.10/share/a.png"],
    ["file://localhost//192.0.2.10/share/a.png"],
    ["file:///\\\\192.0.2.10\\share\\a.png"],
  ])("never reads the server path %s", async (uri) => {
    mocks.readImageAttachment.mockResolvedValue({
      base64: "Zm9v",
      mimeType: "image/png",
    });

    await expect(
      hydrateToolResultImages([{ type: "image", mimeType: "image/png", uri }]),
    ).resolves.toEqual([]);
    expect(mocks.readImageAttachment).not.toHaveBeenCalled();
  });

  it("never reads a server path a tool result names, end to end", async () => {
    mocks.readImageAttachment.mockResolvedValue({
      base64: "Zm9v",
      mimeType: "image/png",
    });

    const images = extractToolResultImages({
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: '{"path":"/\\\\192.0.2.10\\\\share\\\\a.png"}',
          },
        },
        {
          type: "content",
          content: {
            type: "image",
            mimeType: "image/png",
            uri: "file://192.0.2.10/share/b.png",
          },
        },
      ],
      rawOutput: { path: "\\\\192.0.2.10\\share\\c.png" },
    });

    await expect(hydrateToolResultImages(images)).resolves.toEqual([]);
    expect(mocks.readImageAttachment).not.toHaveBeenCalled();
  });
});
