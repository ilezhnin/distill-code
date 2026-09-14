import {
  TRANSCRIPT_AUTO_SCROLL_THRESHOLD_PX,
  TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX,
} from "../transcript/virtual/transcriptVirtualTypes";

export const TIMELINE_AUTO_SCROLL_THRESHOLD_PX =
  TRANSCRIPT_AUTO_SCROLL_THRESHOLD_PX;
export const TIMELINE_PINNED_BOTTOM_THRESHOLD_PX =
  TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX;
export const TIMELINE_JUMP_TO_LATEST_CONTENT_THRESHOLD_PX = 40;
export const TIMELINE_MCP_APP_STICKY_SCROLL_MS = 1500;

export type TimelineScrollIntent =
  | "following-latest"
  | "user-detached"
  | "targeting-message";

export interface TimelineScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function getTimelineBottomScrollTop({
  scrollHeight,
  clientHeight,
}: TimelineScrollMetrics): number {
  return Math.max(0, scrollHeight - clientHeight);
}

export function getTimelineDistanceFromBottom(
  metrics: TimelineScrollMetrics,
): number {
  return Math.max(0, getTimelineBottomScrollTop(metrics) - metrics.scrollTop);
}

export function hasTimelineRealScrollableOverflow({
  metrics,
  bottomPaddingPx,
}: {
  metrics: TimelineScrollMetrics;
  bottomPaddingPx: number;
}): boolean {
  return (
    Math.max(0, metrics.scrollHeight - bottomPaddingPx) > metrics.clientHeight
  );
}

export function isTimelinePinnedToLatest(
  metrics: TimelineScrollMetrics,
): boolean {
  return (
    getTimelineDistanceFromBottom(metrics) <=
    TIMELINE_PINNED_BOTTOM_THRESHOLD_PX
  );
}

export function isTimelineNearLatest(metrics: TimelineScrollMetrics): boolean {
  return (
    getTimelineDistanceFromBottom(metrics) < TIMELINE_AUTO_SCROLL_THRESHOLD_PX
  );
}

export function shouldResumeTimelineFollowFromUserScroll({
  hasUserScrollIntent,
  isNearLatest,
  isPinnedToLatest,
  isStreaming,
  scrollingTowardLatest,
}: {
  hasUserScrollIntent: boolean;
  isNearLatest: boolean;
  isPinnedToLatest: boolean;
  isStreaming: boolean;
  scrollingTowardLatest: boolean;
}): boolean {
  if (hasUserScrollIntent && !scrollingTowardLatest) {
    return false;
  }

  if (isPinnedToLatest) {
    return true;
  }

  return (
    isStreaming && hasUserScrollIntent && scrollingTowardLatest && isNearLatest
  );
}

/**
 * Every scroll write the virtual timeline makes is published back to its
 * geometry engine, so a scroll that lands away from the engine's last observed
 * position was made by something else: find-in-page, focus moving into an
 * older message, a scroll-into-view. Without wheel, touch, pointer or keyboard
 * intent those used to be read as layout corrections and snapped back to the
 * bottom, which left the reader unable to stay where the browser put them.
 * Upward moves only count outside a geometry sync, where browser clamping
 * legitimately moves scrollTop, and never when the result is already latest.
 */
export function isTimelineExternalScrollAwayFromLatest({
  scrollTop,
  observedScrollTop,
  hasUserScrollIntent,
  isPinnedToLatest,
  isGeometrySyncActive,
}: {
  scrollTop: number;
  observedScrollTop: number | null;
  hasUserScrollIntent: boolean;
  isPinnedToLatest: boolean;
  isGeometrySyncActive: boolean;
}): boolean {
  if (
    observedScrollTop == null ||
    hasUserScrollIntent ||
    isPinnedToLatest ||
    isGeometrySyncActive
  ) {
    return false;
  }

  return scrollTop < observedScrollTop - 1;
}

/**
 * Following latest while a response streams keeps scrolling down as it grows.
 * Once reaching the bottom would push the start of a response the reader could
 * see above the viewport, the follow stops on that start instead, so an
 * over-tall answer is read from its beginning rather than chased row by row.
 * Whether the start was in view is decided before the growth, because the
 * geometry engine may already have followed the new bottom by the time the
 * timeline looks. Returns the scrollTop that keeps the start in view, or null
 * while following the bottom still shows it (or it had already scrolled away).
 */
export function getStreamingResponseStartPinScrollTop({
  responseStartWasInView,
  bottomScrollTop,
  responseStartScrollTop,
}: {
  responseStartWasInView: boolean;
  bottomScrollTop: number;
  responseStartScrollTop: number;
}): number | null {
  if (!responseStartWasInView) {
    return null;
  }

  if (bottomScrollTop <= responseStartScrollTop + 1) {
    return null;
  }

  return responseStartScrollTop;
}

/**
 * The first time the timeline sees a streaming response, its start counts as
 * in view only if the reader can see it and following latest will keep
 * showing it: the whole response fits below that start. A response that is
 * already over-tall (a chat opened mid-answer) is followed at its bottom and
 * never pinned back to a start the reader did not scroll to.
 */
export function isStreamingResponseStartInViewAtFirstSight({
  responseStartTopInViewport,
  viewportHeight,
  bottomScrollTop,
  responseStartScrollTop,
}: {
  responseStartTopInViewport: number;
  viewportHeight: number;
  bottomScrollTop: number;
  responseStartScrollTop: number;
}): boolean {
  return (
    responseStartTopInViewport >= -1 &&
    responseStartTopInViewport < viewportHeight &&
    bottomScrollTop <= responseStartScrollTop + 1
  );
}

export function getTimelineRealContentDistanceFromBottom({
  metrics,
  bottomPaddingPx,
}: {
  metrics: TimelineScrollMetrics;
  bottomPaddingPx: number;
}): number {
  return Math.max(
    0,
    metrics.scrollHeight -
      bottomPaddingPx -
      metrics.scrollTop -
      metrics.clientHeight,
  );
}

export function shouldShowTimelineJumpToLatest({
  intent,
  metrics,
  bottomPaddingPx,
}: {
  intent: TimelineScrollIntent;
  metrics: TimelineScrollMetrics;
  bottomPaddingPx: number;
}): boolean {
  if (intent === "following-latest" || intent === "targeting-message") {
    return false;
  }

  if (!hasTimelineRealScrollableOverflow({ metrics, bottomPaddingPx })) {
    return false;
  }

  if (isTimelinePinnedToLatest(metrics)) {
    return false;
  }

  return (
    getTimelineRealContentDistanceFromBottom({ metrics, bottomPaddingPx }) >
    TIMELINE_JUMP_TO_LATEST_CONTENT_THRESHOLD_PX
  );
}
