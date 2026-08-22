import { IconSitemap } from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";

export function ConductorLeadingIcon({ className }: { className?: string }) {
  return (
    <IconSitemap
      data-testid="sidebar-conductor-icon"
      className={cn("size-4 text-sidebar-foreground", className)}
      aria-hidden="true"
    />
  );
}
