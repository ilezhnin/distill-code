/**
 * In-app variant of the Flock loader used for session activity (left nav,
 * responding pill). Same five-frame flock sprite as the startup
 * loader, with a separate loop duration for small repeated placements.
 */
import { FLOCK_LOADER_INLINE_LOOP_MS } from "@/shared/ui/flock-loader-timing";
import {
  FlockLoaderMark,
  type FlockLoaderMarkProps,
} from "@/shared/ui/flock-loader";

export type FlockLoaderInlineProps = FlockLoaderMarkProps;

function FlockLoaderInline({
  durationMs = FLOCK_LOADER_INLINE_LOOP_MS,
  size = 70,
  ...props
}: FlockLoaderInlineProps) {
  return (
    <FlockLoaderMark
      {...props}
      data-slot="flock-loader-inline"
      durationMs={durationMs}
      size={size}
    />
  );
}

export { FlockLoaderInline };
