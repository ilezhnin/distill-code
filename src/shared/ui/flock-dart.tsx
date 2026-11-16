import type { ComponentProps } from "react";

import { cn } from "@/shared/lib/cn";

export interface FlockDartProps extends ComponentProps<"svg"> {
  /**
   * True while the thing the bird marks is in flight: the bird turns the
   * lead's red and, unless `animated` is false, keeps nudging forward.
   */
  active?: boolean;
  /** When false, an active bird stands still. */
  animated?: boolean;
}

/**
 * One bird of the flock, used as a marker beside a line of text: the bullet
 * of the site's feature list, and the sign of a thought in the transcript.
 * Decorative; the text beside it carries the meaning.
 */
function FlockDart({
  active = false,
  animated = true,
  className,
  ...props
}: FlockDartProps) {
  return (
    <svg
      aria-hidden="true"
      data-active={active ? "true" : "false"}
      data-animated={active && animated ? "true" : "false"}
      data-slot="flock-dart"
      viewBox="-6 -6 16 12"
      className={cn("flock-dart h-3 w-4 shrink-0", className)}
      {...props}
    >
      <path d="M8 0L-5 4.6L-2 0L-5-4.6Z" fill="currentColor" />
    </svg>
  );
}

export { FlockDart };
