import { describe, expect, it } from "vitest";
import {
  getReplayAssistantMessageId,
  getReplayCreated,
  getReplayUserMetadata,
} from "../acpReplayMetadata";

describe("getReplayAssistantMessageId", () => {
  it("uses the reply id the host stamps next to the prompt's", () => {
    expect(
      getReplayAssistantMessageId({
        _meta: { distill: { messageId: "u1", assistantMessageId: "a1" } },
      }),
    ).toBe("a1");
  });

  it("reads the host's reply id before the id an agent gave its own chunk", () => {
    // claude-acp and codex-acp number their provider's messages, several to
    // a turn and never on a tool call; the host's id is the one every update
    // of the turn carries.
    expect(
      getReplayAssistantMessageId({
        messageId: "msg_1",
        _meta: { distill: { messageId: "u1", assistantMessageId: "a1" } },
      }),
    ).toBe("a1");
  });

  it("falls back to the agent's own id when the host named no reply", () => {
    expect(
      getReplayAssistantMessageId({
        messageId: "msg_1",
        _meta: { distill: { messageId: "u1" } },
      }),
    ).toBe("msg_1");
  });

  it("derives a reply id from the prompt's id for older history", () => {
    expect(
      getReplayAssistantMessageId({ _meta: { distill: { messageId: "u1" } } }),
    ).toBe("u1:reply");
  });
});

describe("getReplayCreated", () => {
  it("returns milliseconds from a seconds-epoch timestamp", () => {
    const source = { _meta: { distill: { created: 1_700_000_000 } } };
    expect(getReplayCreated(source)).toBe(1_700_000_000_000);
  });

  it("handles the boundary between seconds and milliseconds", () => {
    // Just below the threshold: treated as seconds
    const belowSource = {
      _meta: { distill: { created: 999_999_999_999 } },
    };
    expect(getReplayCreated(belowSource)).toBe(999_999_999_999_000);

    // At the threshold: treated as milliseconds
    const atSource = {
      _meta: { distill: { created: 1_000_000_000_000 } },
    };
    expect(getReplayCreated(atSource)).toBe(1_000_000_000_000);
  });
});

describe("getReplayUserMetadata", () => {
  it("restores delivered steer metadata", () => {
    expect(
      getReplayUserMetadata({
        _meta: { distill: { steer: true } },
      }),
    ).toEqual({ delivery: "steer" });
  });

  it("restores sender attribution on cross-session messages", () => {
    expect(
      getReplayUserMetadata({
        _meta: {
          distill: {
            origin: "distillctl_cross_session",
            distillSenderLabel: "flock-monitor",
            distillDeliveryId: "monitor-event-1",
          },
        },
      }),
    ).toEqual({
      origin: "distillctl_cross_session",
      distillSenderLabel: "flock-monitor",
      distillDeliveryId: "monitor-event-1",
    });
  });
});
