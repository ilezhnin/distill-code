import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_TITLE,
  getDisplaySessionTitle,
  getEditableSessionTitle,
  getSessionTitleFromDraft,
  isDefaultChatTitle,
  isSessionTitleUnchanged,
} from "./sessionTitle";

describe("sessionTitle", () => {
  it("maps the internal default title to the localized display title", () => {
    expect(getDisplaySessionTitle(DEFAULT_CHAT_TITLE, "Nuevo chat")).toBe(
      "Nuevo chat",
    );
    expect(getEditableSessionTitle(DEFAULT_CHAT_TITLE, "Nuevo chat")).toBe(
      "Nuevo chat",
    );
  });

  it("treats the ACP title-case default title as the default title", () => {
    expect(isDefaultChatTitle("New Chat")).toBe(true);
    expect(getDisplaySessionTitle("New Chat", "Nuevo chat")).toBe("Nuevo chat");
  });

  it("treats the localized default title as unchanged while the sentinel is still internal", () => {
    expect(
      isSessionTitleUnchanged("Nuevo chat", DEFAULT_CHAT_TITLE, "Nuevo chat"),
    ).toBe(true);
    expect(
      isSessionTitleUnchanged("Renamed chat", DEFAULT_CHAT_TITLE, "Nuevo chat"),
    ).toBe(false);
  });

  it("uses the whole short prompt instead of a character prefix", () => {
    expect(getSessionTitleFromDraft("List files in folder")).toBe(
      "List files in folder",
    );
  });

  it("titles a long preamble from the actual request at the end", () => {
    const prompt = [
      "[Defaults]",
      "Never assume anyone's gender.",
      "",
      "Follow the context and instructions above for all subsequent turns.",
      "почему у нас для чатов имена создаются тупо беря первые слова промпта?",
    ].join("\n");

    expect(getSessionTitleFromDraft(prompt)).toBe(
      "почему у нас для чатов имена создаются тупо беря первые слова промпта?",
    );
  });

  it("clips a long single-paragraph prompt on a word boundary", () => {
    const prompt =
      "Please implement a thorough architecture audit of the session naming path and then propose a concrete refactor that stops taking the first words of the prompt as the chat title";
    const title = getSessionTitleFromDraft(prompt);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith(" ")).toBe(false);
    expect(prompt.startsWith(title)).toBe(true);
    expect(title.split(" ").length).toBeGreaterThan(8);
  });

  it("falls back to attachment-based titles for attachment-only sends", () => {
    expect(
      getSessionTitleFromDraft("", [
        {
          id: "file-1",
          kind: "file",
          name: "report.pdf",
          path: "/tmp/report.pdf",
        },
      ]),
    ).toBe("Attached file");

    expect(
      getSessionTitleFromDraft("   ", [
        {
          id: "dir-1",
          kind: "directory",
          name: "screenshots",
          path: "/tmp/screenshots",
        },
        {
          id: "dir-2",
          kind: "directory",
          name: "receipts",
          path: "/tmp/receipts",
        },
      ]),
    ).toBe("Attached folders");
  });
});
