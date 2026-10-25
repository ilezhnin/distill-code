import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import { ActiveChatFlockIndicator } from "@/shared/ui/SessionActivityIndicator";

import { SidebarUnreadDot } from "./SidebarUnreadDot";

/**
 * One sidebar row leading slot. It renders exactly one visible state at a time:
 * running > unread > base identity.
 */
export function SidebarLeadingIcon({
  children,
  isRunning = false,
  hasUnread = false,
  activeLabel,
  unreadLabel,
  className,
  baseClassName,
  style,
  testId,
}: {
  children?: ReactNode;
  isRunning?: boolean;
  hasUnread?: boolean;
  activeLabel: string;
  unreadLabel: string;
  className?: string;
  baseClassName?: string;
  /** Per-row geometry the class list cannot express, such as a tree indent. */
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <span
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center",
        className,
      )}
      style={style}
      data-testid={testId}
    >
      {isRunning ? (
        <span
          role="status"
          aria-label={activeLabel}
          className="flex size-full items-center justify-center text-sidebar-foreground"
        >
          <ActiveChatFlockIndicator respectAnimationPreference size={16} />
        </span>
      ) : hasUnread ? (
        <span
          role="status"
          aria-label={unreadLabel}
          className="flex size-full items-center justify-center"
        >
          <SidebarUnreadDot />
        </span>
      ) : children != null ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-full items-center justify-center transition-opacity duration-150",
            baseClassName,
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
