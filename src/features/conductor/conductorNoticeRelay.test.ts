import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

const { deliverEnvelope, steerPromptInSession, conductors } = vi.hoisted(
  () => ({
    deliverEnvelope: vi.fn(async () => ({ status: "dispatched" as const })),
    steerPromptInSession: vi.fn(
      async (
        _sessionId: string,
        _text: string,
        _attachments: unknown,
        _options: unknown,
        handlers?: { onDelivery?: (delivery: "steer") => void },
      ) => {
        handlers?.onDelivery?.("steer");
        return true;
      },
    ),
    conductors: new Set<string>(),
  }),
);

vi.mock("./digestDelivery", () => ({ deliverEnvelope }));
vi.mock("@/features/chat/lib/steerCore", () => ({ steerPromptInSession }));
vi.mock("./conductorGraphStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conductorGraphStore")>()),
  isConductorSession: (sessionId: string) => conductors.has(sessionId),
}));

import {
  CONDUCTOR_NOTICE_RELAY_DELAY_MS,
  resetConductorNoticeRelayForTests,
  skipConductorNoticeRelay,
  startConductorNoticeRelay,
} from "./conductorNoticeRelay";

function notice(
  sessionId: string,
  text: string,
  type: "info" | "warning" | "error" = "warning",
): string {
  const message = createSystemNotificationMessage(text, type);
  useChatStore.getState().addMessage(sessionId, message);
  return message.id;
}

function sentTexts(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => String(call[1]));
}

describe("notices in a conductor's chat reach the conductor", () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    resetConductorNoticeRelayForTests(0);
    deliverEnvelope.mockClear();
    steerPromptInSession.mockClear();
    conductors.clear();
    stop = startConductorNoticeRelay();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("delivers the warnings of a moment to an idle conductor as one message", async () => {
    conductors.add("conductor-a");
    notice(
      "conductor-a",
      "Step 2 (Integrator) runs on GPT-5.6 Sol near its limit.",
    );
    notice(
      "conductor-a",
      "Step 3 (Acceptor) could not start: allowance spent.",
      "error",
    );
    expect(deliverEnvelope).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS + 10);

    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    const [text] = sentTexts(deliverEnvelope);
    expect(text).toContain("[flock-notice]");
    expect(text).toContain("not a digest");
    expect(text).toContain("(warning) Step 2 (Integrator) runs on GPT-5.6 Sol");
    expect(text).toContain("(error) Step 3 (Acceptor) could not start");

    // Each notice goes out once.
    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS * 2);
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
  });

  it("does not wake an idle conductor for an informational notice, and steers it into its next turn", async () => {
    conductors.add("conductor-b");
    notice("conductor-b", "The summary was written to docs/runs/x.md.", "info");
    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS + 10);
    expect(deliverEnvelope).not.toHaveBeenCalled();
    expect(steerPromptInSession).not.toHaveBeenCalled();

    useChatStore.getState().setChatState("conductor-b", "streaming");
    await vi.advanceTimersByTimeAsync(10);

    expect(deliverEnvelope).not.toHaveBeenCalled();
    expect(steerPromptInSession).toHaveBeenCalledTimes(1);
    expect(sentTexts(steerPromptInSession)[0]).toContain(
      "The summary was written to docs/runs/x.md.",
    );
  });

  it("steers notices into a conductor that is working", async () => {
    conductors.add("conductor-c");
    useChatStore.getState().setChatState("conductor-c", "streaming");
    notice("conductor-c", "Step 1 (Scout) was resumed after the restart.");
    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS + 10);
    expect(steerPromptInSession).toHaveBeenCalledTimes(1);
    expect(deliverEnvelope).not.toHaveBeenCalled();
  });

  it("leaves out notices it is told to skip, and chats that are not conductors", async () => {
    conductors.add("conductor-d");
    skipConductorNoticeRelay(
      notice("conductor-d", "Step 2 is blocked; the conductor gets a note."),
    );
    notice("worker-d", "A worker's own notice.");
    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS + 10);
    expect(deliverEnvelope).not.toHaveBeenCalled();
    expect(steerPromptInSession).not.toHaveBeenCalled();
  });

  it("tells the operator when the conductor could not be told, without relaying that", async () => {
    conductors.add("conductor-e");
    deliverEnvelope.mockResolvedValueOnce({
      status: "failed",
      detail: "session is gone",
    } as never);
    notice("conductor-e", "This wave stopped without a decision.");
    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS + 10);
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);

    const messages = useChatStore.getState().messagesBySession["conductor-e"];
    const last = messages?.at(-1);
    expect(last?.role).toBe("system");
    expect(JSON.stringify(last?.content)).toContain("session is gone");

    await vi.advanceTimersByTimeAsync(CONDUCTOR_NOTICE_RELAY_DELAY_MS * 2);
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
  });
});
