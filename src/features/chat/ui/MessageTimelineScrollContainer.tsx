import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

const MESSAGE_TIMELINE_SCROLL_CONTAINER_CLASS =
  "scrollbar-visible relative z-0 min-h-0 flex-1 overflow-y-scroll overscroll-contain [scrollbar-gutter:stable]";

interface MessageTimelineScrollContainerProps
  extends ComponentPropsWithoutRef<"div"> {
  hasFooter: boolean;
}

export const MessageTimelineScrollContainer = forwardRef<
  HTMLDivElement,
  MessageTimelineScrollContainerProps
>(({ children, className, hasFooter, ...props }, forwardedRef) => {
  return (
    <div
      {...props}
      ref={forwardedRef}
      data-testid="message-timeline-scroll"
      className={cn(
        MESSAGE_TIMELINE_SCROLL_CONTAINER_CLASS,
        !hasFooter && "rounded-md bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
});

MessageTimelineScrollContainer.displayName = "MessageTimelineScrollContainer";
