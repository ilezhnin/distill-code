import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for pills that hover over a scrolling transcript without
 * belonging to it (e.g. the chat view's "back to conductor" banner).
 *
 * Composes Button. Base semantic variant: `subtle`.
 *
 * Extra styling on top of subtle:
 * - carries a small shadow so the pill separates from the message content
 *   scrolling underneath it; every Button variant is deliberately
 *   `shadow-none`, so elevation has to be asked for by name
 * - `select-none` so a click on a moving surface never selects the label
 *
 * The soft accent fill is the point: unlike `JumpToLatestButton`, this pill
 * sits over prose the reader is still reading, so it stays quiet rather
 * than claiming the primary fill. Use it for navigation that overlays a
 * transcript. For controls floating over media or artwork, use
 * `GlassButton`; on ordinary content surfaces, use `Button variant="subtle"`.
 *
 * Intent: the recipe owns the elevation so overlay chrome cannot drift when
 * the base variant changes. The base `subtle` contributes role, geometry,
 * focus behavior, and icon sizing. No flag props are used or accepted.
 */
const TRANSCRIPT_OVERLAY_RECIPE = "select-none shadow-sm";

export type TranscriptOverlayButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const TranscriptOverlayButton = React.forwardRef<
  HTMLButtonElement,
  TranscriptOverlayButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className={cn(TRANSCRIPT_OVERLAY_RECIPE, className)}
    {...props}
  />
));
TranscriptOverlayButton.displayName = "TranscriptOverlayButton";
