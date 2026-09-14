import { describe, expect, it } from "vitest";
import {
  getStreamingResponseStartPinScrollTop,
  isStreamingResponseStartInViewAtFirstSight,
  isTimelineExternalScrollAwayFromLatest,
} from "../timelineScrollIntent";

describe("isTimelineExternalScrollAwayFromLatest", () => {
  const base = {
    scrollTop: 400,
    observedScrollTop: 1200,
    hasUserScrollIntent: false,
    isPinnedToLatest: false,
    isGeometrySyncActive: false,
  };

  it("treats an upward move the timeline did not write as leaving latest", () => {
    expect(isTimelineExternalScrollAwayFromLatest(base)).toBe(true);
  });

  it("ignores a scroll event that lands on the position the timeline wrote", () => {
    expect(
      isTimelineExternalScrollAwayFromLatest({ ...base, scrollTop: 1200.5 }),
    ).toBe(false);
  });

  it("ignores downward moves toward latest", () => {
    expect(
      isTimelineExternalScrollAwayFromLatest({ ...base, scrollTop: 1500 }),
    ).toBe(false);
  });

  it("leaves wheel, touch, pointer and keyboard scrolls to the intent path", () => {
    expect(
      isTimelineExternalScrollAwayFromLatest({
        ...base,
        hasUserScrollIntent: true,
      }),
    ).toBe(false);
  });

  it("does not detach when browser clamping during a geometry sync moves scrollTop", () => {
    expect(
      isTimelineExternalScrollAwayFromLatest({
        ...base,
        isGeometrySyncActive: true,
      }),
    ).toBe(false);
  });

  it("does not detach when the move still lands on latest", () => {
    expect(
      isTimelineExternalScrollAwayFromLatest({
        ...base,
        isPinnedToLatest: true,
      }),
    ).toBe(false);
  });

  it("does not detach before the engine has observed any position", () => {
    expect(
      isTimelineExternalScrollAwayFromLatest({
        ...base,
        observedScrollTop: null,
      }),
    ).toBe(false);
  });
});

describe("isStreamingResponseStartInViewAtFirstSight", () => {
  it("counts a new response whose start is visible and which still fits", () => {
    expect(
      isStreamingResponseStartInViewAtFirstSight({
        responseStartTopInViewport: 153,
        viewportHeight: 615,
        bottomScrollTop: 12,
        responseStartScrollTop: 153,
      }),
    ).toBe(true);
  });

  it("does not count a response that is already taller than the viewport", () => {
    expect(
      isStreamingResponseStartInViewAtFirstSight({
        responseStartTopInViewport: 153,
        viewportHeight: 615,
        bottomScrollTop: 3400,
        responseStartScrollTop: 153,
      }),
    ).toBe(false);
  });

  it("does not count a start the reader cannot see", () => {
    expect(
      isStreamingResponseStartInViewAtFirstSight({
        responseStartTopInViewport: -400,
        viewportHeight: 615,
        bottomScrollTop: 500,
        responseStartScrollTop: 600,
      }),
    ).toBe(false);
  });
});

describe("getStreamingResponseStartPinScrollTop", () => {
  it("keeps following the bottom while the whole response still fits", () => {
    expect(
      getStreamingResponseStartPinScrollTop({
        responseStartWasInView: true,
        bottomScrollTop: 240,
        responseStartScrollTop: 240,
      }),
    ).toBeNull();
  });

  it("stops on the response start once reaching the bottom would hide it", () => {
    expect(
      getStreamingResponseStartPinScrollTop({
        responseStartWasInView: true,
        bottomScrollTop: 520,
        responseStartScrollTop: 240,
      }),
    ).toBe(240);
  });

  it("keeps following the bottom when the response start had already scrolled away", () => {
    expect(
      getStreamingResponseStartPinScrollTop({
        responseStartWasInView: false,
        bottomScrollTop: 2100,
        responseStartScrollTop: 240,
      }),
    ).toBeNull();
  });
});
