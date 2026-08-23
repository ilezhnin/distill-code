import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import type { ChatState } from "@/shared/types/chat";
import { Button } from "@/shared/ui/button";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";

import { brigadeWaitIndicator } from "../brigadeActivity";
import type { SessionNode } from "../types";
import {
  isPokeInFlight,
  pokeSessionForInterimSummary,
  subscribeToPokeState,
} from "../wavePoke";

/**
 * Persistent "this chat is waiting on external work" line above the composer,
 * plus the poke that asks it for an interim summary.
 *
 * The poke was deliberately withheld in 1d: until the wave engine landed, any
 * message into a conductor chat was intercepted by the auto-spawn heuristic and
 * started a second brigade instead of asking about the first. That hook is
 * gone, so the button is safe and lives here — next to the line that tells the
 * operator there is something to be impatient about.
 *
 * The in-flight flag is read from `wavePoke.ts` rather than held as component
 * state: this indicator unmounts the moment the poke lands (the session goes
 * from idle to running, and the line is idle-only), so local state would be a
 * guard that disappears exactly when it matters.
 */
export function BrigadeWaitIndicator({
  chatState,
  nodes,
  sessionId,
  className,
}: {
  chatState: ChatState;
  nodes: readonly SessionNode[];
  /** Session the poke is sent to. Omit and no poke is offered. */
  sessionId?: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const { visible, workingCount } = brigadeWaitIndicator({
    chatState,
    children: nodes,
  });
  const pokePending = useSyncExternalStore(
    subscribeToPokeState,
    () => (sessionId ? isPokeInFlight(sessionId) : false),
    () => false,
  );

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
      {sessionId ? (
        <Button
          type="button"
          variant="ghost"
          size="xxs"
          className="shrink-0"
          data-testid="brigade-poke-button"
          disabled={pokePending}
          onClick={() => pokeSessionForInterimSummary(sessionId)}
        >
          {pokePending ? t("conductor.poke.pending") : t("conductor.poke.ask")}
        </Button>
      ) : null}
    </div>
  );
}
