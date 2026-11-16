/**
 * One full pass of the motion through the flock (startup screen): the time
 * from the lead bird's surge to its next one. A calm, even beat.
 */
export const FLOCK_LOADER_LOOP_MS = 1600;

/**
 * Loop duration for the in-app inline loader (left nav activity, responding
 * pill). Kept separate from the startup loader so the two animations can be
 * tuned independently; a small mark reads better a little quicker.
 */
export const FLOCK_LOADER_INLINE_LOOP_MS = 1400;
