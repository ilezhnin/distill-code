import type { CSSProperties } from "react";

import { cn } from "@/shared/lib/cn";

export type TreeGuideShape = "pass" | "last" | "stub";

/**
 * One column of a tree's guide line, drawn the full height of its row so the
 * line reads as continuous from one row to the next:
 *
 * - `pass`: the line runs straight through — an ancestor's line beside a
 *   row, or a child that is not its parent's last;
 * - `last`: the line turns in a rounded elbow toward the parent's last
 *   child;
 * - `stub`: the line starts under a parent's icon and runs to the row's
 *   bottom edge, so the children's line hangs from the icon.
 *
 * Absolutely positioned inside a `relative` row; the caller sets `left` to
 * the column of the icon the line hangs from.
 */
export function TreeGuide({
  shape,
  className,
  style,
}: {
  shape: TreeGuideShape;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="tree-guide"
      data-shape={shape}
      className={cn(
        "pointer-events-none absolute inset-y-0 w-4 text-muted-foreground/45",
        className,
      )}
      style={style}
    >
      {shape === "last" ? (
        <span className="absolute left-[calc(50%-0.5px)] right-0 top-0 h-[calc(50%+0.5px)] rounded-bl-[6px] border-b border-l border-current" />
      ) : (
        // Drawn as a border like the elbow, so both snap to the same device
        // pixels and the line never steps where they meet.
        <span
          className={cn(
            "absolute bottom-0 left-[calc(50%-0.5px)] border-l border-current",
            shape === "stub" ? "top-[calc(50%+10px)]" : "top-0",
          )}
        />
      )}
    </span>
  );
}
