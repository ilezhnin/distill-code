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
