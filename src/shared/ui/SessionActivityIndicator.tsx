import { useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import { RESPONDING_SHIMMER_PROPS } from "@/shared/ui/ai-elements/shimmer";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { DistillLoaderInline } from "@/shared/ui/distill-loader-inline";

const ACTIVE_CHAT_DISTILL_SIZE_PX = 14;
const WORKING_INDICATOR_ENTRANCE_CLASSES =
  "transition-opacity duration-200 ease-out animate-in fade-in-0";

interface SessionActivityIndicatorProps {
  isRunning?: boolean;
  hasUnread?: boolean;
  variant?: "inline" | "overlay";
  className?: string;
}

export function ActiveChatDistillIndicator({
  className,
  respectAnimationPreference = false,
  size = ACTIVE_CHAT_DISTILL_SIZE_PX,
}: {
  className?: string;
  respectAnimationPreference?: boolean;
  size?: number;
}) {
  const shouldReduceMotion = useReducedMotion();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const motionEnabled =
    !shouldReduceMotion &&
    (!respectAnimationPreference ||
      workingIndicatorAnimationPreference.enabled);

  return (
    <DistillLoaderInline
      animated={motionEnabled}
      className={className}
      decorative
      size={size}
    />
  );
}

export function ActiveChatPulseDot({ className }: { className?: string }) {
  const shouldReduceMotion = useReducedMotion();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const motionEnabled =
    workingIndicatorAnimationPreference.enabled && !shouldReduceMotion;

  return (
    <span
      aria-hidden="true"
      data-slot="active-chat-pulse-dot"
      className={cn(
        "size-[7px] rounded-full bg-info",
        motionEnabled && "animate-[active-chat-dot-pulse_ease-in-out_infinite]",
        className,
      )}
      style={
        motionEnabled
          ? {
              animationDuration: `${RESPONDING_SHIMMER_PROPS.duration}s`,
            }
          : undefined
      }
    />
  );
}

export function SessionActivityIndicator({
  isRunning = false,
  hasUnread = false,
  variant = "inline",
  className,
}: SessionActivityIndicatorProps) {
  const { t } = useTranslation("sidebar");
  const shouldReduceMotion = useReducedMotion();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const motionEnabled =
    workingIndicatorAnimationPreference.enabled && !shouldReduceMotion;

  if (isRunning) {
    if (variant === "overlay") {
      return (
        <span
          role="status"
          aria-label={t("status.chatActive")}
          className={cn(
            "absolute -right-1 -top-1 flex items-center justify-center",
            motionEnabled && WORKING_INDICATOR_ENTRANCE_CLASSES,
            className,
          )}
        >
          <DistillLoaderInline
            animated={motionEnabled}
            decorative
            size={ACTIVE_CHAT_DISTILL_SIZE_PX}
          />
        </span>
      );
    }

    return (
      <span
        role="status"
        aria-label={t("status.chatActive")}
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          motionEnabled && WORKING_INDICATOR_ENTRANCE_CLASSES,
          className,
        )}
      >
        <DistillLoaderInline
          animated={motionEnabled}
          decorative
          size={ACTIVE_CHAT_DISTILL_SIZE_PX}
        />
      </span>
    );
  }

  if (!hasUnread) {
    return null;
  }

  if (variant === "overlay") {
    return (
      <span
        role="status"
        aria-label={t("status.unreadMessages")}
        className={cn(
          "absolute -right-0.5 -top-0.5 h-2 w-2 shrink-0 rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0",
          className,
        )}
      />
    );
  }

  return (
    <span
      role="status"
      aria-label={t("status.unreadMessages")}
      className={cn(
        "h-2 w-2 shrink-0 rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0",
        className,
      )}
    />
  );
}
