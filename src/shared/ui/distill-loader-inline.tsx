/**
 * In-app variant of the Distill loader used for session activity (left nav,
 * responding pill). Same five-frame distillation sprite as the startup
 * loader, with a separate loop duration for small repeated placements.
 */
import { DISTILL_LOADER_INLINE_LOOP_MS } from "@/shared/ui/distill-loader-timing";
import {
  DistillLoaderMark,
  type DistillLoaderMarkProps,
} from "@/shared/ui/distill-loader";

export type DistillLoaderInlineProps = DistillLoaderMarkProps;

function DistillLoaderInline({
  durationMs = DISTILL_LOADER_INLINE_LOOP_MS,
  size = 70,
  ...props
}: DistillLoaderInlineProps) {
  return (
    <DistillLoaderMark
      {...props}
      data-slot="distill-loader-inline"
      durationMs={durationMs}
      size={size}
    />
  );
}

export { DistillLoaderInline };
