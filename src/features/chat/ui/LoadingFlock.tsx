import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import {
  RESPONDING_SHIMMER_PROPS,
  Shimmer,
} from "@/shared/ui/ai-elements/shimmer";
import { cn } from "@/shared/lib/cn";

export type LoadingChatState =
  | "idle"
  | "thinking"
  | "streaming"
  | "waiting"
  | "compacting";

interface LoadingFlockProps {
  chatState?: LoadingChatState;
  /**
   * What the turn is doing right now — the step in flight or the heading of
   * its latest thought. Replaces the generic state word when known.
   */
  activity?: string;
  /** When the turn started, in ms; shows how long it has been working. */
  startedAt?: number;
  className?: string;
  motionPreset?: "default" | "responding";
}

const LOADING_FADE_S = 0.45;
const DEFAULT_LOADING_SHIMMER_PROPS = {
  delay: 0.35,
  duration: 2.2,
  spread: 5,
  tone: "current",
} as const;

const MESSAGE_KEY_BY_STATE: Record<
  Exclude<LoadingChatState, "idle">,
  "thinking" | "responding" | "compacting"
> = {
  thinking: "thinking",
  streaming: "responding",
  waiting: "responding",
  compacting: "compacting",
};

/** `12s`, `1m 05s`, `1h 02m` — the way a status line counts. */
export function formatWorkingTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function useSecondsSince(startedAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return startedAt === undefined ? null : (now - startedAt) / 1000;
}

export function LoadingFlock({
  chatState = "idle",
  activity,
  startedAt,
  className,
  motionPreset = "default",
}: LoadingFlockProps) {
  const { t } = useTranslation("chat");
  const shouldReduceMotion = useReducedMotion();
  const seconds = useSecondsSince(chatState === "idle" ? undefined : startedAt);
  if (chatState === "idle") {
    return null;
  }

  const message =
    chatState !== "compacting" && activity
      ? activity
      : t(`loading.${MESSAGE_KEY_BY_STATE[chatState]}`);
  const elapsed =
    seconds !== null && seconds >= 1 ? formatWorkingTime(seconds) : null;

  return (
    <motion.div
      className={cn(
        "mb-3 flex min-h-4 min-w-0 items-center gap-1.5 px-1 text-xs font-normal text-current",
        className,
      )}
      role="status"
      aria-label={message}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : LOADING_FADE_S }}
    >
      {shouldReduceMotion ? (
        <span className="min-w-0 truncate">{message}</span>
      ) : (
        <Shimmer
          as="span"
          className="min-w-0 truncate text-xs"
          {...(motionPreset === "responding"
            ? RESPONDING_SHIMMER_PROPS
            : DEFAULT_LOADING_SHIMMER_PROPS)}
        >
          {message}
        </Shimmer>
      )}
      {elapsed ? (
        <span className="shrink-0 tabular-nums opacity-70">{elapsed}</span>
      ) : null}
    </motion.div>
  );
}
