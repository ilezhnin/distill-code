import type { CSSProperties } from "react";

import { cn } from "@/shared/lib/cn";

export type TreeGuideShape = "pass" | "last" | "stub";

/**
 * One column of a tree's guide line, drawn the full height of its row so the
 * line reads as continuous from one row to the next:
 *
 * - `pass`: the line runs straight through — an ancestor's line beside a
 *   row, or a child that is not its parent's last;
 * - `last`: the line ends here in an elbow — the parent's last child;
 * - `stub`: the line starts under a parent's start and runs to the row's
 *   bottom edge, so the children's line hangs from the parent.
 *
 * A column is one tree step wide. The caller sets `left` to where the
 * column's parent row starts; the line runs 8px in, under the middle of
 * that row's icon or the first letters of its name, and the elbow stops
 * just short of the child one step in.
 *
 * Absolutely positioned inside a `relative` row.
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
        "pointer-events-none absolute inset-y-0 w-6 text-muted-foreground/45",
        className,
      )}
      style={style}
    >
      <span
        className={cn(
          "absolute left-2 w-px -translate-x-1/2 bg-current",
          shape === "stub" ? "top-[calc(50%+10px)]" : "top-0",
          shape === "last" ? "bottom-1/2" : "bottom-0",
        )}
      />
      {shape === "last" ? (
        <span className="absolute left-2 right-1 top-1/2 h-px -translate-y-1/2 bg-current" />
      ) : null}
    </span>
  );
}
