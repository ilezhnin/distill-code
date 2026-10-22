export const FLOCK_LOADER_FRAME_COUNT = 5;

/** One full pass through the Flock loader frames (startup screen). */
export const FLOCK_LOADER_LOOP_MS = FLOCK_LOADER_FRAME_COUNT * 160;

/**
 * Loop duration for the in-app inline loader (left nav activity, responding
 * pill). Kept separate from the startup loader so the two animations can be
 * tuned independently.
 */
export const FLOCK_LOADER_INLINE_LOOP_MS = FLOCK_LOADER_FRAME_COUNT * 140;
