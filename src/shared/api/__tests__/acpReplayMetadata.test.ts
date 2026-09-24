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
            distillSenderLabel: "distill-monitor",
            distillDeliveryId: "monitor-event-1",
          },
        },
      }),
    ).toEqual({
      origin: "distillctl_cross_session",
      distillSenderLabel: "distill-monitor",
      distillDeliveryId: "monitor-event-1",
    });
  });
});
