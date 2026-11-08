import { describe, expect, it } from "vitest";
import {
  recordTranscriptProjectionTiming,
  type TranscriptProjectionTimingState,
} from "./transcriptDiagnostics";

describe("projection timing", () => {
  it("counts each update once without replaying cold-load timing on scroll and resize", () => {
    const state: TranscriptProjectionTimingState = {
      lastSnapshot: null,
      updateDurationsMs: [],
    };
    const initial = {
      sessionId: "chat",
      sessionEpoch: 0,
      projectionDurationMs: 40,
    };
    for (let render = 0; render < 50; render += 1) {
      recordTranscriptProjectionTiming(state, initial, 240);
    }
    expect(state.updateDurationsMs).toEqual([]);

    const update = { ...initial, projectionDurationMs: 20 };
    for (let render = 0; render < 50; render += 1) {
      recordTranscriptProjectionTiming(state, update, 240);
    }
    recordTranscriptProjectionTiming(
      state,
      { ...update, projectionDurationMs: 2 },
      240,
    );
    expect(state.updateDurationsMs).toEqual([20, 2]);
  });

  it("bounds history and starts a new baseline for a restored session", () => {
    const state: TranscriptProjectionTimingState = {
      lastSnapshot: null,
      updateDurationsMs: [],
    };
    for (const duration of [40, 1, 2, 3]) {
      recordTranscriptProjectionTiming(
        state,
        {
          sessionId: "chat",
          sessionEpoch: 0,
          projectionDurationMs: duration,
        },
        2,
      );
    }
    expect(state.updateDurationsMs).toEqual([2, 3]);
    recordTranscriptProjectionTiming(
      state,
      {
        sessionId: "chat",
        sessionEpoch: 1,
        projectionDurationMs: 50,
      },
      2,
    );
    expect(state.updateDurationsMs).toEqual([]);
    recordTranscriptProjectionTiming(
      state,
      {
        sessionId: "chat",
        sessionEpoch: 1,
        projectionDurationMs: 25,
      },
      2,
    );
    expect(state.updateDurationsMs).toEqual([25]);
  });
});
