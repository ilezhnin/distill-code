import { describe, expect, it } from "vitest";
import { extractToolStructuredContent } from "../acpToolCallContent";

const output = "line of terminal output\n".repeat(200);
const textContent = (text: string) => [
  { type: "content", content: { type: "text", text } },
];

describe("tool structured content", () => {
  it("drops long strings the text result already carries, keeping the rest", () => {
    const terminal = { command: "pnpm test", exit_code: 0, output };
    const fileRead = {
      FileContent: { content: output, absolute_path: "E:/a" },
    };
    const content = textContent(`$ pnpm test\n${output}`);

    expect(
      extractToolStructuredContent({ content, rawOutput: terminal }),
    ).toEqual({ command: "pnpm test", exit_code: 0 });
    expect(
      extractToolStructuredContent({ content, rawOutput: fileRead }),
    ).toEqual({ FileContent: { absolute_path: "E:/a" } });
    // The update itself stays as the bridge sent it.
    expect(terminal.output).toBe(output);
    expect(fileRead.FileContent.content).toBe(output);
  });

  it("drops image bytes the response already holds as an image block", () => {
    const data = "iVBORw0KGgo".repeat(200);
    const rawOutput = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      },
    ];
    const content = [
      {
        type: "content",
        content: { type: "image", mimeType: "image/png", data },
      },
    ];

    expect(extractToolStructuredContent({ content, rawOutput })).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png" } },
    ]);
    expect(rawOutput[0].source.data).toBe(data);
  });

  it("keeps rawOutput whole when no text result repeats it", () => {
    const rawOutput = { output, exit_code: 1 };

    expect(extractToolStructuredContent({ rawOutput })).toBe(rawOutput);
    expect(
      extractToolStructuredContent({
        content: textContent("a different, short summary"),
        rawOutput,
      }),
    ).toBe(rawOutput);
  });
});
