/**
 * Distill activity mark for startup. Plays the five-frame distillation
 * sprite; the settled state is the first frame.
 */
import type { CSSProperties, ComponentProps } from "react";

import distillLoaderStrip from "@/shared/assets/distill-loader-strip.png";
import { cn } from "@/shared/lib/cn";
import {
  BERD_LOADER_FRAME_COUNT,
  BERD_LOADER_LOOP_MS,
} from "@/shared/ui/berd-loader-timing";

export interface DistillLoaderMarkProps
  extends Omit<ComponentProps<"span">, "color"> {
  /** When false, renders the first frame without looping. */
  animated?: boolean;
  /**
   * When true, marks the loader as purely decorative:
   * sets `role="none"`, `aria-hidden="true"`, and removes the label.
   */
  decorative?: boolean;
  /** Width and height of the rendered mark in CSS pixels. */
  size?: number;
  /** Kept for API compatibility with the previous SVG loaders. */
  color?: string;
  durationMs?: number;
}

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

export function DistillLoaderMark({
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  animated = true,
  className,
  color,
  decorative = false,
  durationMs = BERD_LOADER_LOOP_MS,
  height,
  size = 70,
  style,
  width,
  ...rest
}: DistillLoaderMarkProps) {
  const resolvedSize = boxSize(size, width, height);
  const markStyle: CSSProperties & Record<`--${string}`, string> = {
    width: resolvedSize,
    height: resolvedSize,
    color,
    backgroundImage: `url(${distillLoaderStrip})`,
    backgroundSize: `${resolvedSize * BERD_LOADER_FRAME_COUNT}px ${resolvedSize}px`,
    "--distill-loader-size": `${resolvedSize}px`,
    ...style,
  };

  if (animated) {
    markStyle.animation = `distill-loader-frames ${durationMs}ms steps(${BERD_LOADER_FRAME_COUNT}) infinite`;
  }

  const markClassName = cn(
    "block shrink-0 overflow-hidden bg-left bg-no-repeat [image-rendering:pixelated]",
    className,
  );

  if (decorative) {
    return (
      <span
        {...rest}
        aria-hidden="true"
        className={markClassName}
        data-animated={animated ? "true" : "false"}
        role="none"
        style={markStyle}
      />
    );
  }

  return (
    <span
      {...rest}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel ?? "Loading"}
      className={markClassName}
      data-animated={animated ? "true" : "false"}
      role="img"
      style={markStyle}
    />
  );
}

export type BerdLoaderProps = DistillLoaderMarkProps;

function BerdLoader({
  durationMs = BERD_LOADER_LOOP_MS,
  ...props
}: BerdLoaderProps) {
  return (
    <DistillLoaderMark
      {...props}
      data-slot="berd-loader"
      durationMs={durationMs}
    />
  );
}

export { BerdLoader };
