import type { ReactNode } from "react";
import { IconChevronRight } from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";

export interface DisclosureLineProps {
  /** The one line that is always shown. */
  label: ReactNode;
  /** Drawn before the label, sized by the caller. */
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the line opens onto. */
  children: ReactNode;
  className?: string;
}

/**
 * A one-line label that opens onto the detail under it.
 *
 * How a transcript says something without spending a paragraph on it: a step
 * the agent took, a thought, a plan step, a notice from the app. The line is
 * the part a person scans; the detail is one click away and never in the way.
 */
export function DisclosureLine({
  label,
  icon,
  open,
  onOpenChange,
  children,
  className,
}: DisclosureLineProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          flush
          size="sm"
          className="flex h-auto w-full min-w-0 justify-start gap-1.5 px-0 py-0 text-left"
          rightIcon={
            <IconChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
          }
        >
          {icon}
          <span className="min-w-0 truncate text-sm font-normal">{label}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
