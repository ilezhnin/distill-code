import { SIDEBAR_CHILD_WORK_DOT_CLASS } from "@/shared/ui/sidebar-tokens";
import { cn } from "@/shared/lib/cn";

/**
 * Bare "this chat's agents are still working" ring. Shown on a chat that is
 * itself idle while its graph children are still starting/running/waiting, so
 * the operator can tell from the sidebar that a result is still coming.
 *
 * The parent owns positioning and accessibility labeling via `role="status"`,
 * matching `SidebarUnreadDot`.
 */
export function SidebarChildWorkDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="sidebar-child-work-dot"
      className={cn(SIDEBAR_CHILD_WORK_DOT_CLASS, className)}
    />
  );
}
