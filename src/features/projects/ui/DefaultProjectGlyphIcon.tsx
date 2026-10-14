import type { SVGProps } from "react";

import { cn } from "@/shared/lib/cn";
import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { pillCssColor } from "../lib/pillTones";

const VIEW_BOX = "0 0 24 24";
/** Keep project folders aligned with custom project images. */
export const PROJECT_GLYPH_ICON_CLASS = "size-[18px] shrink-0";

function resolveProjectColor(color?: string | null) {
  const storedColor = color || DEFAULT_PROJECT_COLOR;
  return (
    pillCssColor(storedColor) ??
    (storedColor.startsWith("#")
      ? storedColor
      : pillCssColor(DEFAULT_PROJECT_COLOR)) ??
    undefined
  );
}

type DefaultProjectGlyphIconProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  color?: string | null;
  projectId?: string;
};

/** Outlined project folder, retaining the user's chosen project color. */
export function DefaultProjectGlyphIcon({
  color,
  projectId,
  className,
  style,
  ...props
}: DefaultProjectGlyphIconProps) {
  const resolvedColor = resolveProjectColor(color);

  return (
    <svg
      viewBox={VIEW_BOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      data-project-color-swatch={projectId}
      className={cn(PROJECT_GLYPH_ICON_CLASS, className)}
      style={{
        color: resolvedColor,
        ...style,
      }}
      {...props}
    >
      <path d="M5 19l2.757-7.351A1 1 0 0 1 8.693 11H21a1 1 0 0 1 .986 1.164l-.996 5.211A2 2 0 0 1 19.026 19H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
