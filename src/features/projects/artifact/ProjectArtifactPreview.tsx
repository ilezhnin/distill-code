import { useMemo } from "react";
import { cn } from "@/shared/lib/cn";
import { DefaultProjectGlyphIcon } from "../ui/DefaultProjectGlyphIcon";
import { deriveProjectArtifactState } from "./deriveProjectArtifactState";
import type { ProjectArtifactInput } from "./types";

interface ProjectArtifactPreviewProps {
  input: ProjectArtifactInput;
  className?: string;
  variant?: "preview" | "tile";
}

/**
 * The project's glyph on its accent glow. This used to be the fallback for a
 * three.js cube textured with artwork downloaded from Block's CDN; with the
 * CDN gone it is the preview.
 */
export function ProjectArtifactPreview({
  input,
  className,
  variant = "preview",
}: ProjectArtifactPreviewProps) {
  const state = useMemo(() => deriveProjectArtifactState(input), [input]);
  const isTile = variant === "tile";

  return (
    <div
      data-testid="project-artifact-preview"
      className={cn(
        "relative isolate flex h-full w-full items-center justify-center",
        isTile
          ? "overflow-visible bg-transparent"
          : "overflow-hidden rounded-[28px] bg-transparent",
        className,
      )}
    >
      {isTile ? null : (
        <div
          className="absolute inset-[8%] transition-colors duration-700 ease-out"
          style={{
            background: `radial-gradient(ellipse at center, ${state.accentCssColor} 0%, ${state.accentCssColor} 28%, transparent 66%)`,
            opacity: 0.34,
          }}
        />
      )}
      <div
        className={cn(
          "relative flex aspect-square items-center justify-center rounded-[22%] border border-border/35 text-foreground/80",
          isTile
            ? "w-[44%] bg-card/90 shadow-sm"
            : "w-[44%] bg-surface-glass-strong/40 shadow-[var(--shadow-chat)] backdrop-blur-xl",
        )}
        aria-hidden="true"
      >
        <DefaultProjectGlyphIcon
          color={state.accentColor}
          className={isTile ? "size-[80%]" : "size-[38%]"}
          data-testid="project-artifact-placeholder-glyph"
        />
      </div>
    </div>
  );
}
