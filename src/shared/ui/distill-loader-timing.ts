export const DISTILL_LOADER_FRAME_COUNT = 5;

/** One full pass through the Distill loader frames (startup screen). */
export const DISTILL_LOADER_LOOP_MS = DISTILL_LOADER_FRAME_COUNT * 160;

/**
 * Loop duration for the in-app inline loader (left nav activity, responding
 * pill). Kept separate from the startup loader so the two animations can be
 * tuned independently.
 */
export const DISTILL_LOADER_INLINE_LOOP_MS = DISTILL_LOADER_FRAME_COUNT * 140;
