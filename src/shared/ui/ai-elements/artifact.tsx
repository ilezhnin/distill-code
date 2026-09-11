import { Button } from "@/shared/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";

export type ArtifactProps = HTMLAttributes<HTMLDivElement>;

export const Artifact = ({ className, ...props }: ArtifactProps) => (
  <div
    className={cn(
      "flex flex-col overflow-hidden rounded-md border bg-card shadow-sm",
      className,
    )}
    {...props}
  />
);

export type ArtifactHeaderProps = HTMLAttributes<HTMLDivElement>;

/**
 * Header strip for an artifact surface.
 *
 * Deliberately unfilled: it inherits the surface it is mounted on (`Artifact`'s
 * `bg-card`) and separates from the content with a hairline rule,
 * matching the app's other panel headers. An earlier `bg-muted/50` fill read
 * as a grey band that blended into the window chrome instead of looking like
 * part of the panel. Per DESIGN.md's Flat First Rule, the separation is
 * structural (a border and title weight), not tonal.
 */
export const ArtifactHeader = ({
  className,
  ...props
}: ArtifactHeaderProps) => (
  <div
    className={cn(
      "flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 px-3 py-2",
      className,
    )}
    {...props}
  />
);

export type ArtifactTitleProps = HTMLAttributes<HTMLParagraphElement>;

/**
 * Filename label in an artifact header.
 *
 * A filename is an identifier, not a section header, so it stays at Body
 * weight — matching how filenames render everywhere else (artifact chips, the
 * artifacts widget, changed-file rows). `font-display` semibold is reserved
 * for real section and page titles; using it here made the doc viewer shout
 * louder than the page titles around it.
 */
export const ArtifactTitle = ({ className, ...props }: ArtifactTitleProps) => (
  <p className={cn("truncate text-sm text-foreground", className)} {...props} />
);

export type ArtifactActionsProps = HTMLAttributes<HTMLDivElement>;

export const ArtifactActions = ({
  className,
  ...props
}: ArtifactActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);

export type ArtifactActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
  icon?: LucideIcon;
};

/**
 * Icon action in an artifact header.
 *
 * Uses the design system's `icon-sm` geometry and the `ghost` variant, whose
 * icon compound variant already rests at `muted-foreground` and lifts to
 * `foreground` on hover — so no color or hover classes are hand-applied here.
 */
export const ArtifactAction = ({
  tooltip,
  label,
  icon: Icon,
  children,
  className,
  size = "icon-sm",
  variant = "ghost",
  ...props
}: ArtifactActionProps) => {
  const button = (
    <Button
      className={className}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {Icon ? <Icon /> : children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};
