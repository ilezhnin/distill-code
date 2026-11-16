/**
 * Flock activity mark. Five birds drawn as on levocat.com, the lead one in
 * red. In flight each bird surges along the flock's heading a beat after the
 * one ahead of it, so the motion runs from the lead to the tail; the settled
 * state is the mark standing still.
 */
import type { CSSProperties, ComponentProps } from "react";

import { cn } from "@/shared/lib/cn";
import { FLOCK_LOADER_LOOP_MS } from "@/shared/ui/flock-loader-timing";

export interface FlockLoaderMarkProps
  extends Omit<ComponentProps<"svg">, "color"> {
  /** When false, renders the mark standing still. */
  animated?: boolean;
  /**
   * When true, marks the loader as purely decorative:
   * sets `role="none"`, `aria-hidden="true"`, and removes the label.
   */
  decorative?: boolean;
  /**
   * When true, the birds fly in one after another before settling into the
   * loop. For a loader that appears alone on a screen; a small one beside a
   * label should simply be there.
   */
  entrance?: boolean;
  /** Width and height of the rendered mark in CSS pixels. */
  size?: number;
  /** Color of the birds behind the lead. Defaults to the text color. */
  color?: string;
  /** One full pass of the motion through the flock, in milliseconds. */
  durationMs?: number;
}

const BIRD_PATH = "M8 0L-5 4.6L-2 0L-5-4.6Z";
const SMALL_MARK_PX = 28;

/** The flock, lead first: the order the motion runs through it. */
const BIRDS = [
  { x: 34, y: 13, scale: 1 },
  { x: 22.5, y: 12, scale: 0.85 },
  { x: 29.1, y: 23.4, scale: 0.85 },
  { x: 11.1, y: 11, scale: 0.85 },
  { x: 24.3, y: 33.8, scale: 0.85 },
] as const;

function boxSize(
  size: number,
  width?: string | number,
  height?: string | number,
): number {
  if (typeof width === "number" && width > 0) {
    return width;
  }
  if (typeof height === "number" && height > 0) {
    return height;
  }
  return size;
}

export function FlockLoaderMark({
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  animated = true,
  className,
  color,
  decorative = false,
  durationMs = FLOCK_LOADER_LOOP_MS,
  entrance = false,
  height,
  size = 70,
  style,
  width,
  ...rest
}: FlockLoaderMarkProps) {
  const resolvedSize = boxSize(size, width, height);
  const markStyle: CSSProperties & Record<`--${string}`, string> = {
    color,
    "--flock-loop": `${durationMs}ms`,
    // A small mark surges further in its own units, or the motion is lost.
    "--flock-reach": resolvedSize < SMALL_MARK_PX ? "1.5" : "1",
    ...style,
  };

  return (
    <svg
      {...rest}
      aria-hidden={decorative ? "true" : ariaHidden}
      aria-label={decorative ? undefined : (ariaLabel ?? "Loading")}
      className={cn("flock-mark block shrink-0", className)}
      data-animated={animated ? "true" : "false"}
      data-entrance={animated && entrance ? "true" : undefined}
      height={resolvedSize}
      role={decorative ? "none" : "img"}
      style={markStyle}
      viewBox="0 0 44 44"
      width={resolvedSize}
    >
      {BIRDS.map((bird, index) => (
        <g
          className="flock-mark-arrive"
          key={`${bird.x}:${bird.y}`}
          style={{ "--flock-i": String(index) } as CSSProperties}
        >
          <g className="flock-mark-bird">
            <path
              className={index === 0 ? "flock-mark-lead" : undefined}
              d={BIRD_PATH}
              fill="currentColor"
              transform={`translate(${bird.x} ${bird.y}) rotate(-30) scale(${bird.scale})`}
            />
          </g>
        </g>
      ))}
    </svg>
  );
}

export type FlockLoaderProps = FlockLoaderMarkProps;

function FlockLoader({
  durationMs = FLOCK_LOADER_LOOP_MS,
  entrance = true,
  ...props
}: FlockLoaderProps) {
  return (
    <FlockLoaderMark
      {...props}
      data-slot="flock-loader"
      durationMs={durationMs}
      entrance={entrance}
    />
  );
}

export { FlockLoader };
