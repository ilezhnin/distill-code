import { describe, expect, it } from "vitest";
import {
  getReplayCreated,
  getReplayMessageId,
  getReplayUserMetadata,
} from "../acpReplayMetadata";

describe("getReplayMessageId", () => {
  it("returns messageId from top-level field", () => {
    expect(getReplayMessageId({ messageId: "msg_1" })).toBe("msg_1");
  });

  it("returns messageId from _meta.goose", () => {
    const source = {
      _meta: { distill: { messageId: "msg_2" } },
    };
    expect(getReplayMessageId(source)).toBe("msg_2");
  });

  it("prefers top-level messageId over _meta.distill.messageId", () => {
    const source = {
      messageId: "top",
      _meta: { distill: { messageId: "nested" } },
    };
    expect(getReplayMessageId(source)).toBe("top");
  });

  it("returns null when no messageId is present", () => {
    expect(getReplayMessageId({})).toBeNull();
  });

  it("returns null for empty string messageId", () => {
    expect(getReplayMessageId({ messageId: "" })).toBeNull();
  });

  it("returns null when _meta is null", () => {
    expect(getReplayMessageId({ _meta: null })).toBeNull();
  });

  it("returns null when _meta.goose is not an object", () => {
    expect(getReplayMessageId({ _meta: { distill: "not-object" } })).toBeNull();
  });

  it("returns null when _meta is an array", () => {
    expect(
      getReplayMessageId({ _meta: [] as unknown as Record<string, unknown> }),
    ).toBeNull();
  });
});

describe("getReplayCreated", () => {
  it("returns milliseconds from a seconds-epoch timestamp", () => {
    const source = { _meta: { distill: { created: 1_700_000_000 } } };
    expect(getReplayCreated(source)).toBe(1_700_000_000_000);
  });

  it("returns milliseconds directly when already in milliseconds", () => {
    const source = { _meta: { distill: { created: 1_700_000_000_000 } } };
    expect(getReplayCreated(source)).toBe(1_700_000_000_000);
  });

  it("falls back to createdAt if created is missing", () => {
    const source = { _meta: { distill: { createdAt: 1_700_000_000 } } };
    expect(getReplayCreated(source)).toBe(1_700_000_000_000);
  });

  it("returns undefined when no timestamp is present", () => {
    expect(getReplayCreated({})).toBeUndefined();
  });

  it("returns undefined for non-numeric values", () => {
    const source = { _meta: { distill: { created: "not-a-date" } } };
    expect(getReplayCreated(source)).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    const source = { _meta: { distill: { created: NaN } } };
    expect(getReplayCreated(source)).toBeUndefined();
  });

  it("returns undefined for Infinity", () => {
    const source = { _meta: { distill: { created: Infinity } } };
    expect(getReplayCreated(source)).toBeUndefined();
  });

  it("returns undefined for negative timestamps", () => {
    const source = { _meta: { distill: { created: -1 } } };
    expect(getReplayCreated(source)).toBeUndefined();
  });

  it("returns undefined for negative epoch values", () => {
    const source = { _meta: { distill: { created: -1_000_000_000 } } };
    expect(getReplayCreated(source)).toBeUndefined();
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

  it("returns zero as a valid timestamp", () => {
    const source = { _meta: { distill: { created: 0 } } };
    expect(getReplayCreated(source)).toBe(0);
  });

  it("returns undefined when _meta.goose is an array", () => {
    const source = {
      _meta: { distill: [{ created: 1_700_000_000 }] },
    };
    expect(getReplayCreated(source)).toBeUndefined();
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

  it("restores known berdctl cross-session origin metadata", () => {
    expect(
      getReplayUserMetadata({
        _meta: { distill: { origin: "berdctl_cross_session" } },
      }),
    ).toEqual({ origin: "berdctl_cross_session" });
  });

  it("restores sender attribution on cross-session messages", () => {
    expect(
      getReplayUserMetadata({
        _meta: {
          distill: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "berd-monitor",
            berdDeliveryId: "monitor-event-1",
          },
        },
      }),
    ).toEqual({
      origin: "berdctl_cross_session",
      berdSenderLabel: "berd-monitor",
      berdDeliveryId: "monitor-event-1",
    });
  });

  it("ignores unknown origins", () => {
    expect(
      getReplayUserMetadata({
        _meta: { distill: { origin: "some_future_origin" } },
      }),
    ).toBeUndefined();
  });
});
