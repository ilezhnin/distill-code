import { describe, expect, it } from "vitest";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { appendAttachmentPaths } from "./attachments";

function fileAttachment(path: string): ChatAttachmentDraft {
  return {
    id: path,
    kind: "file",
    name: path.split("\\").at(-1) ?? path,
    path,
  } as ChatAttachmentDraft;
}

describe("appendAttachmentPaths", () => {
  // The Windows default user folder is `C:\Users\First Last\…`, so bare
  // space-separated paths read as several files to the agent.
  it("puts every attachment on its own quoted line", () => {
    expect(
      appendAttachmentPaths("summarize", [
        fileAttachment("C:\\Users\\Ivan Lezhnin\\Documents\\spec v2.docx"),
        fileAttachment("C:\\repo\\notes.md"),
      ]),
    ).toBe(
      'summarize\n\n"C:\\Users\\Ivan Lezhnin\\Documents\\spec v2.docx"\n"C:\\repo\\notes.md"',
    );
  });

  it("sends the paths alone when the operator typed nothing", () => {
    expect(appendAttachmentPaths("", [fileAttachment("C:\\a b\\c.txt")])).toBe(
      '"C:\\a b\\c.txt"',
    );
  });

  it("leaves the prompt untouched when nothing has a path", () => {
    expect(appendAttachmentPaths("hello", undefined)).toBe("hello");
    expect(
      appendAttachmentPaths("hello", [
        { id: "1", kind: "file", name: "dropped.pdf" } as ChatAttachmentDraft,
      ]),
    ).toBe("hello");
  });

  it("does not rewrite a path that already contains a quote", () => {
    expect(appendAttachmentPaths("read", [fileAttachment('/tmp/we"ird')])).toBe(
      'read\n\n/tmp/we"ird',
    );
  });
});
