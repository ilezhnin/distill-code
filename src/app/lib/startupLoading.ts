import { FLOCK_LOADER_LOOP_MS } from "@/shared/ui/flock-loader-timing";

const STARTUP_LOADING_LOOP_COUNT = 2;

/** Minimum time the startup loader stays visible (two full loader loops). */
export const STARTUP_LOADING_MIN_DISPLAY_MS =
  STARTUP_LOADING_LOOP_COUNT * FLOCK_LOADER_LOOP_MS;

/** Size of the flock mark on the startup screen. */
export const STARTUP_LOADING_LOGO_SIZE_PX = 84;
