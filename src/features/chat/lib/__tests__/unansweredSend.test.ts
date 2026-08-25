import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import {
  findUnansweredUserMessage,
  unansweredSendToReport,
} from "../unansweredSend";

function message(
  role: Message["role"],
  text: string,
  id = `${role}-${text}`,
): Message {
  return {
    id,
    role,
    created: 1,
    content: [{ type: "text", text }],
  };
}

function notice(text: string): Message {
  return {
    id: `sys-${text}`,
    role: "system",
    created: 2,
    content: [{ type: "systemNotification", notificationType: "info", text }],
  };
}

const idle = {
  isRunning: false,
  hasError: false,
  hasQueuedSend: false,
  isAgentManaged: false,
};

describe("findUnansweredUserMessage", () => {
  it("finds the message a killed turn left hanging", () => {
    const found = findUnansweredUserMessage([
      message("user", "First"),
      message("assistant", "Answered"),
      message("user", "Second"),
    ]);

    expect(found?.id).toBe("user-Second");
  });

  it("says nothing when the agent replied", () => {
    expect(
      findUnansweredUserMessage([
        message("user", "Ask"),
        message("assistant", "Answer"),
      ]),
    ).toBeNull();
  });

  it("counts an empty assistant turn as a reply", () => {
    // A turn that produced nothing is a different problem from one that was
    // never delivered, and claiming the message was dropped would be a lie.
    expect(
      findUnansweredUserMessage([
        message("user", "Ask"),
        message("assistant", ""),
      ]),
    ).toBeNull();
  });

  it("looks past the notices the load itself wrote", () => {
    const found = findUnansweredUserMessage([
      message("user", "Hanging"),
      notice("Session loaded"),
    ]);
    expect(found?.id).toBe("user-Hanging");
  });

  it("has nothing to offer for a message with no words", () => {
    expect(findUnansweredUserMessage([message("user", "   ")])).toBeNull();
  });

  it("has no opinion on an empty transcript", () => {
    expect(findUnansweredUserMessage([])).toBeNull();
    expect(findUnansweredUserMessage(undefined)).toBeNull();
  });
});

describe("unansweredSendToReport", () => {
  const hanging = [message("user", "Hanging")];

  it("reports a transcript that ends on the operator", () => {
    expect(unansweredSendToReport(hanging, idle)?.id).toBe("user-Hanging");
  });

  it("stays quiet while the session is running", () => {
    // A live run legitimately ends on the operator's message.
    expect(
      unansweredSendToReport(hanging, { ...idle, isRunning: true }),
    ).toBeNull();
  });

  it("stays quiet when the session already reported a failure", () => {
    // The error notice has said what went wrong; this would say the same
    // event again, less precisely.
    expect(
      unansweredSendToReport(hanging, { ...idle, hasError: true }),
    ).toBeNull();
  });

  it("leaves a wave worker to the conductor that scheduled it", () => {
    // The graph already reports a killed step as a stopped node with no
    // report, and this notice's button would re-run it outside its wave.
    expect(
      unansweredSendToReport(hanging, { ...idle, isAgentManaged: true }),
    ).toBeNull();
  });

  it("stays quiet while a queued send is still waiting", () => {
    expect(
      unansweredSendToReport(hanging, { ...idle, hasQueuedSend: true }),
    ).toBeNull();
  });
});
