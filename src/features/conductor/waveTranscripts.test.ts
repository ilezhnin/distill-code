import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import type { Message } from "@/shared/types/messages";

const loadSessionMessages = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages,
}));

const {
  TRANSCRIPT_HYDRATION_RETRY_MS,
  readConductorTranscript,
  resetConductorTranscriptsForTests,
} = await import("./waveTranscripts");

const SESSION = "conductor-1";

function message(id: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text: "hello" }],
    metadata: { completionStatus: "completed" },
  };
}

function notice(text: string): Message {
  return {
    id: `notice-${text}`,
    role: "system",
    created: 1,
    content: [{ type: "systemNotification", text, notificationType: "error" }],
  };
}

/** Lets the hydration promise settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("readConductorTranscript", () => {
  beforeEach(() => {
    resetConductorTranscriptsForTests();
    loadSessionMessages.mockReset();
    loadSessionMessages.mockImplementation(async () => true);
    useChatStore.setState({ messagesBySession: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConductorTranscriptsForTests();
  });

  it("does not take the notice a failed load leaves behind as a transcript", async () => {
    // The real failure path: the loader resolves `false` and appends a system
    // notice under this very key. Read as "loaded", that notice made the
    // lifecycle re-deliver a digest it could not find the marker of, and it
    // stopped this module from ever asking for the transcript again.
    loadSessionMessages.mockImplementation(async () => {
      useChatStore.getState().addMessage(SESSION, notice("could not load"));
      return false;
    });
    const onHydrated = vi.fn();
    expect(readConductorTranscript(SESSION, onHydrated).kind).toBe("unknown");
    await flush();
    expect(onHydrated).toHaveBeenCalled();
    expect(useChatStore.getState().messagesBySession[SESSION]).toHaveLength(1);
    expect(readConductorTranscript(SESSION, () => undefined).kind).toBe(
      "unknown",
    );

    // The real answer, once a replay finally works, is still read.
    useChatStore.setState({
      messagesBySession: { [SESSION]: [message("m1")] },
    });
    expect(readConductorTranscript(SESSION, () => undefined).kind).toBe(
      "loaded",
    );
  });

  it("asks once while a load is in flight, however often it is called", () => {
    let release: (() => void) | undefined;
    loadSessionMessages.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    for (let index = 0; index < 5; index += 1) {
      expect(readConductorTranscript(SESSION, () => undefined).kind).toBe(
        "unknown",
      );
    }
    expect(loadSessionMessages).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("backs off before asking again for a transcript that never arrived", async () => {
    // The tick fires on every streamed token; an ungated retry would be a
    // session replay per token for as long as the wave waits.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    readConductorTranscript(SESSION, () => undefined);
    await flush();
    expect(loadSessionMessages).toHaveBeenCalledTimes(1);

    vi.setSystemTime(TRANSCRIPT_HYDRATION_RETRY_MS - 1);
    readConductorTranscript(SESSION, () => undefined);
    expect(loadSessionMessages).toHaveBeenCalledTimes(1);

    vi.setSystemTime(TRANSCRIPT_HYDRATION_RETRY_MS + 1);
    readConductorTranscript(SESSION, () => undefined);
    expect(loadSessionMessages).toHaveBeenCalledTimes(2);
  });
});
