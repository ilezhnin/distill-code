/**
 * In-app variant of the Distill loader used for session activity (left nav,
 * responding pill). Same five-frame distillation sprite as the startup
 * loader, with a separate loop duration for small repeated placements.
 */
import { BERD_LOADER_INLINE_LOOP_MS } from "@/shared/ui/berd-loader-timing";
import {
  DistillLoaderMark,
  type DistillLoaderMarkProps,
} from "@/shared/ui/berd-loader";

export type BerdLoaderInlineProps = DistillLoaderMarkProps;

function BerdLoaderInline({
  durationMs = BERD_LOADER_INLINE_LOOP_MS,
  size = 70,
  ...props
}: BerdLoaderInlineProps) {
  return (
    <DistillLoaderMark
      {...props}
      data-slot="berd-loader-inline"
      durationMs={durationMs}
      size={size}
    />
  );
}

export { BerdLoaderInline };
