import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { BrigadeStatusGlyph } from "@/features/conductor/ui/BrigadeChip";
import { providerDisplayName } from "@/features/providers/providerCatalog";
import { modelNameFromExecutionTarget } from "@/features/stats/lib/usageProvider";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { splitLegacyFoldedModelId } from "@/shared/lib/foldedModelId";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Progress } from "@/shared/ui/progress";
import { useStoredContextUsage } from "../../hooks/useStoredContextUsage";
import {
  buildContextTeam,
  contextWindowPressure,
  contextWindowShare,
  type ContextTeamMember,
  type ContextWindowPressure,
  type ContextWindowUsage,
} from "../../lib/contextTeam";
import {
  useChatSessionStore,
  type ChatSession,
} from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";

/** Shown where a figure belongs and none has been reported. */
const NO_VALUE = "—";
/** One level of the team tree, in px; deeper levels share the last inset. */
const TEAM_INDENT_PX = 12;
const TEAM_MAX_INDENT_DEPTH = 4;

const PRESSURE_INDICATOR_CLASS: Record<ContextWindowPressure, string> = {
  normal: "bg-foreground",
  high: "bg-warning",
  critical: "bg-destructive",
};

interface ContextUsageWidgetProps {
  sessionId: string;
  /** Whether the rail is on screen. A hidden rail asks the host nothing. */
  active: boolean;
  /** Opens another chat of the team. Omitted → the rows are not links. */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * A chat's context window, from live traffic when this window has heard from
 * the chat and from the stored transcript's tail when it has not.
 *
 * A snapshot that names neither tokens nor a window is a usage update that
 * carried only cost; it says nothing about the context and reads as none.
 */
function useContextWindowUsage(
  sessionId: string,
  stored: ReadonlyMap<string, ContextWindowUsage>,
): ContextWindowUsage | null {
  const live = useChatStore((state) => {
    const runtime = state.sessionStateById[sessionId];
    return runtime?.hasUsageSnapshot ? runtime.tokenState : undefined;
  });
  if (live && (live.accumulatedTotal > 0 || live.contextLimit > 0)) {
    return { used: live.accumulatedTotal, limit: live.contextLimit };
  }
  return stored.get(sessionId) ?? null;
}

/** The figures of one window, formatted once for the block and the rows. */
function useContextWindowLabels(usage: ContextWindowUsage | null) {
  const { t } = useTranslation("chat");
  const { formatNumber } = useLocaleFormatting();
  if (!usage) {
    return {
      share: null,
      pressure: "normal" as const,
      percent: undefined,
      tokens: undefined,
    };
  }
  const share = contextWindowShare(usage);
  const compact = (value: number) =>
    formatNumber(value, {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    });
  const percentDigits = share !== null && share > 0 && share < 0.1 ? 1 : 0;
  return {
    share,
    pressure: contextWindowPressure(share),
    percent:
      share === null
        ? undefined
        : formatNumber(share, {
            style: "percent",
            minimumFractionDigits: percentDigits,
            maximumFractionDigits: percentDigits,
          }),
    tokens:
      usage.limit > 0
        ? t("contextPanel.usage.tokens", {
            used: compact(usage.used),
            limit: compact(usage.limit),
          })
        : t("contextPanel.usage.tokensOnly", { used: compact(usage.used) }),
  };
}

/**
 * What an agent runs on: its harness, and the model as the chat names it.
 *
 * The chat wins over the graph node for the model, because it carries the
 * name the harness reported and follows a model switch; the node keeps the id
 * the agent was spawned with, which is the fallback for a chat this window
 * has not loaded.
 */
function runTarget(
  member: Pick<ContextTeamMember, "node">,
  session: ChatSession | undefined,
): { harnessId?: string; model?: string } {
  const target = session?.executionTarget;
  const nodeModelId = member.node?.modelId;
  const nodeModel = nodeModelId
    ? (splitLegacyFoldedModelId(nodeModelId)?.modelId ?? nodeModelId)
    : undefined;
  return {
    harnessId: member.node?.harnessId || target?.harnessId || undefined,
    model: modelNameFromExecutionTarget(target) ?? nodeModel,
  };
}

function RunTargetLabel({
  harnessId,
  model,
  className,
}: {
  harnessId?: string;
  model?: string;
  className?: string;
}) {
  const harnessName = harnessId ? providerDisplayName(harnessId) : undefined;
  const text = model ?? harnessName;
  if (!text) return null;
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      title={[harnessName, model].filter(Boolean).join(" · ")}
    >
      {harnessId ? getProviderIcon(harnessId, "size-3.5 shrink-0") : null}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

export function ContextUsageWidget({
  sessionId,
  active,
  onOpenSession,
}: ContextUsageWidgetProps) {
  const { t } = useTranslation("chat");
  const sessions = useChatSessionStore((state) => state.sessions);
  const nodesById = useConductorGraphStore((state) => state.nodesById);

  const sessionsByAnyId = useMemo(() => {
    const byId = new Map<string, ChatSession>();
    for (const session of sessions) {
      byId.set(session.id, session);
      if (session.clientSessionId && !byId.has(session.clientSessionId)) {
        byId.set(session.clientSessionId, session);
      }
    }
    return byId;
  }, [sessions]);
  const currentSession = sessionsByAnyId.get(sessionId);
  const currentClientSessionId = currentSession?.clientSessionId;

  const team = useMemo(
    () =>
      buildContextTeam({
        nodesById,
        currentIds: [sessionId, currentClientSessionId],
        resolveSession: (id) => sessionsByAnyId.get(id),
      }),
    [currentClientSessionId, nodesById, sessionId, sessionsByAnyId],
  );
  const usageSessionIds = useMemo(
    () => [sessionId, ...team.map((member) => member.sessionId)],
    [sessionId, team],
  );
  const stored = useStoredContextUsage(usageSessionIds, active);

  const currentNode =
    nodesById[sessionId] ??
    (currentClientSessionId ? nodesById[currentClientSessionId] : undefined);

  return (
    <div className="w-full text-sm font-normal" data-testid="context-usage">
      <section className="space-y-2">
        <p className="text-muted-foreground">{t("contextPanel.usage.title")}</p>
        <CurrentContextWindow
          sessionId={sessionId}
          stored={stored}
          target={runTarget({ node: currentNode }, currentSession)}
        />
      </section>
      {team.length > 0 ? (
        <section className="mt-5 space-y-1.5" data-testid="context-team">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {t("contextPanel.usage.team")}
            </p>
            <span className="text-xs tabular-nums text-muted-foreground">
              {team.length}
            </span>
          </div>
          <ul className="-mx-2 space-y-0.5">
            {team.map((member) => (
              <ContextTeamRow
                key={member.sessionId}
                member={member}
                session={sessionsByAnyId.get(member.sessionId)}
                stored={stored}
                onOpenSession={onOpenSession}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CurrentContextWindow({
  sessionId,
  stored,
  target,
}: {
  sessionId: string;
  stored: ReadonlyMap<string, ContextWindowUsage>;
  target: { harnessId?: string; model?: string };
}) {
  const { t } = useTranslation("chat");
  const usage = useContextWindowUsage(sessionId, stored);
  const { share, pressure, percent, tokens } = useContextWindowLabels(usage);

  return (
    <div className="space-y-2" data-testid="context-usage-current">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-foreground">
          {usage
            ? percent
              ? t("contextPanel.usage.percentUsed", { percent })
              : tokens
            : t("contextPanel.usage.empty")}
        </span>
        {usage && percent ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {tokens}
          </span>
        ) : null}
      </div>
      <Progress
        className="h-1.5 bg-muted"
        indicatorClassName={PRESSURE_INDICATOR_CLASS[pressure]}
        value={(share ?? 0) * 100}
        aria-label={t("contextPanel.usage.title")}
      />
      <RunTargetLabel
        harnessId={target.harnessId}
        model={target.model}
        className="text-xs text-muted-foreground"
      />
    </div>
  );
}

const ContextTeamRow = memo(function ContextTeamRow({
  member,
  session,
  stored,
  onOpenSession,
}: {
  member: ContextTeamMember;
  session: ChatSession | undefined;
  stored: ReadonlyMap<string, ContextWindowUsage>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation("chat");
  const usage = useContextWindowUsage(member.sessionId, stored);
  const { share, pressure, percent, tokens } = useContextWindowLabels(usage);
  const name = member.name?.trim() || t("contextPanel.usage.unnamedChat");
  const target = runTarget(member, session);
  // The open chat is where the operator already is; every other row is the
  // way to that agent.
  const canOpen = Boolean(onOpenSession) && !member.isCurrent;

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
        {member.node ? (
          <BrigadeStatusGlyph status={member.node.status} />
        ) : null}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {percent ?? NO_VALUE}
        </span>
      </span>
      <Progress
        className="h-1 bg-muted"
        indicatorClassName={PRESSURE_INDICATOR_CLASS[pressure]}
        value={(share ?? 0) * 100}
        aria-label={t("contextPanel.usage.rowAria", { name })}
      />
      <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <RunTargetLabel harnessId={target.harnessId} model={target.model} />
        {tokens ? (
          <span className="ml-auto shrink-0 tabular-nums">{tokens}</span>
        ) : null}
      </span>
    </>
  );
  const rowClassName = cn(
    "flex w-full min-w-0 flex-col gap-1 rounded-sm px-2 py-1.5 text-left",
    member.isCurrent && "bg-muted/60",
  );

  return (
    <li
      data-testid="context-team-row"
      data-session-id={member.sessionId}
      data-current={member.isCurrent ? "true" : undefined}
      data-pressure={pressure}
      style={{
        paddingLeft:
          Math.min(member.depth, TEAM_MAX_INDENT_DEPTH) * TEAM_INDENT_PX,
      }}
    >
      {canOpen ? (
        <button
          type="button"
          className={cn(
            rowClassName,
            "cursor-pointer transition-colors duration-100 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
          )}
          title={t("contextPanel.usage.openChat", { name })}
          onClick={() => onOpenSession?.(member.sessionId)}
        >
          {body}
        </button>
      ) : (
        <div
          className={rowClassName}
          aria-current={member.isCurrent ? "true" : undefined}
        >
          {body}
        </div>
      )}
    </li>
  );
});
