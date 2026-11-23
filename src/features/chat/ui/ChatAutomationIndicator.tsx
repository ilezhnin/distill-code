import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { useLocaleFormatting } from "@/shared/i18n";
import { useNow } from "@/features/conductor/ui/MonitorJobList";
import { formatRunDuration } from "@/features/conductor/brigadeChipSummary";
import {
  goalCounters,
  selectChatGoal,
  useChatGoalStore,
  type ChatGoal,
} from "@/features/chat-automation/goalStore";
import {
  selectChatLoops,
  useChatLoopStore,
  loopCounters,
  type ChatLoop,
} from "@/features/chat-automation/loopStore";
import { goalTurnDeliveryId } from "@/features/chat-automation/commands";
import { useChatStore } from "@/features/chat/stores/chatStore";

function TaskRow({
  title,
  status,
  facts,
  paused,
  onToggle,
  endLabel,
  onEnd,
}: {
  title: string;
  status: string;
  facts: string;
  paused: boolean;
  onToggle?: () => void;
  endLabel: string;
  onEnd: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <section aria-label={title} className="flex items-start gap-2 py-1">
      <div className="min-w-0 flex-1">
        <p title={title} className="truncate text-sm text-foreground">
          {title}
        </p>
        <p className="break-words text-xs text-muted-foreground">
          {status} · {facts}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {onToggle && (
          <Button type="button" size="xs" variant="ghost" onClick={onToggle}>
            {t(paused ? "automation.resume" : "automation.pause")}
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={onEnd}>
          {endLabel}
        </Button>
      </div>
    </section>
  );
}

function AutomationRows({
  sessionId,
  goal,
  loops,
}: {
  sessionId: string;
  goal?: ChatGoal;
  loops: readonly ChatLoop[];
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { formatDate, formatNumber } = useLocaleFormatting();
  // A resume can change the deadline between two clock ticks.
  useNow(1000);
  const now = Date.now();
  const goalWorking = useChatStore((store) =>
    Boolean(
      goal?.pendingMessageId &&
        store.messagesBySession[sessionId]?.findLast(
          (message) =>
            message.id === goal.pendingMessageId &&
            message.metadata?.distillDeliveryId ===
              goalTurnDeliveryId(goal.id, goal.turns),
        ),
    ),
  );
  const goalStore = useChatGoalStore.getState();
  const loopStore = useChatLoopStore.getState();
  const counters = goal && goalCounters(sessionId, goal, now);
  return (
    <div className="mb-1 max-h-[25vh] overflow-y-auto rounded-md border border-border bg-card px-3 py-1">
      {goal && counters && (
        <TaskRow
          title={t("automation.goalTitle", { objective: goal.objective })}
          status={
            goal.status === "paused"
              ? t("automation.paused", { reason: goal.note })
              : goal.status === "reached"
                ? t("automation.reached")
                : t(goalWorking ? "automation.working" : "automation.waiting")
          }
          facts={t("automation.goalCounts", {
            turns: counters.turns - goal.turnsAtResume,
            cap: goal.maxTurns,
            tokens: formatNumber(counters.tokens),
            elapsed: formatRunDuration(counters.elapsedMs),
          })}
          paused={goal.status === "paused"}
          onToggle={
            goal.status === "reached"
              ? undefined
              : () =>
                  goal.status === "paused"
                    ? goalStore.resume(sessionId)
                    : goalStore.pause(sessionId)
          }
          endLabel={t("common:actions.clear")}
          onEnd={() => goalStore.clear(sessionId)}
        />
      )}
      {loops.map((loop) => {
        const { expiresAt, nextRunAt } = loopCounters(sessionId, loop);
        const next =
          nextRunAt !== null && nextRunAt >= expiresAt
            ? t("automation.notice.afterExpiry")
            : nextRunAt !== null && nextRunAt > now
              ? t("automation.nextRun", {
                  delay: formatRunDuration(nextRunAt - now),
                })
              : undefined;
        const status =
          loop.status === "paused"
            ? t("automation.paused", { reason: loop.note })
            : loop.pending
              ? [t("automation.working"), next].filter(Boolean).join(" · ")
              : (next ?? t("automation.waiting"));
        const interval = loop.intervalMs
          ? t("automation.interval", {
              interval: formatRunDuration(loop.intervalMs),
            })
          : t("automation.selfPaced");
        return (
          <TaskRow
            key={loop.id}
            title={t("automation.loopTitle", {
              number: loop.number,
              prompt: loop.prompt,
            })}
            status={status}
            facts={t("automation.schedule", {
              interval,
              expiry: formatDate(expiresAt, {
                dateStyle: "short",
                timeStyle: "short",
              }),
            })}
            paused={loop.status === "paused"}
            onToggle={() =>
              loop.status === "paused"
                ? loopStore.resume(sessionId, loop.id)
                : loopStore.pause(sessionId, loop.id)
            }
            endLabel={t("common:actions.stop")}
            onEnd={() => loopStore.stop(sessionId, loop.id)}
          />
        );
      })}
    </div>
  );
}

export function ChatAutomationIndicator({ sessionId }: { sessionId: string }) {
  const goal = useChatGoalStore(selectChatGoal(sessionId));
  const loops = useChatLoopStore(selectChatLoops(sessionId));
  return goal || loops.length ? (
    <AutomationRows sessionId={sessionId} goal={goal} loops={loops} />
  ) : null;
}
