export const BERD_LOADER_FRAME_COUNT = 5;
export const BERD_LOADER_FRAME_PX = 16;

/** One full pass through the Distill loader frames (startup screen). */
export const BERD_LOADER_LOOP_MS = BERD_LOADER_FRAME_COUNT * 160;

/**
 * Loop duration for the in-app inline loader (left nav activity, responding
 * pill). Kept separate from the startup loader so the two animations can be
 * tuned independently.
 */
export const BERD_LOADER_INLINE_LOOP_MS = BERD_LOADER_FRAME_COUNT * 140;
