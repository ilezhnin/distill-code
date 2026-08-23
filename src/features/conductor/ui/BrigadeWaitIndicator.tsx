import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import type { ChatState } from "@/shared/types/chat";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";

import { brigadeWaitIndicator } from "../brigadeActivity";
import type { SessionNode } from "../types";

/**
 * Persistent "this chat is waiting on external work" line above the composer.
 *
 * The chat itself is idle, so nothing else on screen says the operator should
 * expect a message later. Deliberately has no poke/"hurry up" action: until
 * the wave engine ships, anything typed into a conductor chat is consumed by
 * the auto-spawn path and would start a second brigade.
 */
export function BrigadeWaitIndicator({
  chatState,
  nodes,
  className,
}: {
  chatState: ChatState;
  nodes: readonly SessionNode[];
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const { visible, workingCount } = brigadeWaitIndicator({
    chatState,
    children: nodes,
  });

  if (!visible) return null;

  return (
    <div
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2 px-1 pb-1.5 text-xs text-muted-foreground",
        className,
      )}
      data-testid="brigade-wait-indicator"
      role="status"
    >
      <ActiveChatPulseDot className="shrink-0" />
      <span className="truncate">
        {t("conductor.waitingOnChildren", { count: workingCount })}
      </span>
    </div>
  );
}
