import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  MessageSquare,
  RefreshCw,
  Clock,
} from "lucide-react";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import {
  buildUsageSummary,
  useUsageLedger,
} from "@/features/stats/lib/usageLedger";
import { formatWorkedDuration } from "@/features/stats/lib/usageFormatters";
import { providerDisplayName } from "@/features/stats/lib/usageProvider";
import {
  recordLiveTokenState,
  syncChatSessionsIntoUsageLedger,
  syncConductorNodesIntoUsageLedger,
} from "@/features/stats/lib/usageRecorder";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { StatCard } from "./stats/StatCard";
import { UsageOverviewPane } from "./stats/UsageOverviewPane";

const SESSION_PAGE_LOAD_LIMIT = 30;

async function refreshUsageSources(): Promise<void> {
  const sessionStore = useChatSessionStore.getState();
  if (!sessionStore.hasHydratedSessions) {
    await sessionStore.loadSessions();
  }
  let pages = 0;
  while (
    useChatSessionStore.getState().hasMoreSessions &&
    pages < SESSION_PAGE_LOAD_LIMIT
  ) {
    pages += 1;
    await useChatSessionStore.getState().loadMoreSessions();
  }
  syncChatSessionsIntoUsageLedger();
  const tokenStates = useChatStore.getState().sessionStateById;
  for (const [sessionId, runtime] of Object.entries(tokenStates)) {
    if (runtime.hasUsageSnapshot) {
      recordLiveTokenState(sessionId, runtime.tokenState);
    }
  }
}

export function StatsSettings() {
  const { t } = useTranslation("settings");
  const ledger = useUsageLedger();
  const sessions = useChatSessionStore((state) => state.sessions);
  const conductorNodes = useConductorGraphStore((state) => state.nodesById);
  const { readyAgentIds } = useAgentProviderStatus();
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    void refreshUsageSources();
  }, []);

  useEffect(() => {
    syncChatSessionsIntoUsageLedger(sessions);
  }, [sessions]);

  useEffect(() => {
    syncConductorNodesIntoUsageLedger(Object.values(conductorNodes));
  }, [conductorNodes]);

  const extraAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of Object.values(conductorNodes)) {
      if (node.role === "worker" || node.role === "orchestrator") {
        ids.add(node.sessionId);
      }
    }
    return ids;
  }, [conductorNodes]);

  const summary = buildUsageSummary(extraAgentIds);

  const enabledProviderIds = useMemo(
    () => ["goose", ...readyAgentIds],
    [readyAgentIds],
  );

  const providerOptions = useMemo(() => {
    const ids = new Set<string>(enabledProviderIds);
    for (const session of Object.values(ledger.sessions)) {
      ids.add(session.providerId);
    }
    return [...ids].sort((left, right) =>
      providerDisplayName(left).localeCompare(providerDisplayName(right)),
    );
  }, [enabledProviderIds, ledger.sessions]);

  const trackingSince = summary.firstEventAt
    ? t("stats.trackingSince", {
        date: new Date(summary.firstEventAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      })
    : "";

  const workedLabel = formatWorkedDuration(summary.workedMs, {
    zero: t("stats.duration.zero"),
    daysHours: (days, hours) => t("stats.duration.daysHours", { days, hours }),
    hoursMinutes: (hours, minutes) =>
      t("stats.duration.hoursMinutes", { hours, minutes }),
    minutesSeconds: (minutes, seconds) =>
      t("stats.duration.minutesSeconds", { minutes, seconds }),
    seconds: (seconds) => t("stats.duration.seconds", { seconds }),
  });

  const handleRefresh = () => {
    setIsRefreshing(true);
    void refreshUsageSources().finally(() => {
      setIsRefreshing(false);
    });
  };

  const activeProviderLabel =
    providerFilter == null
      ? t("stats.overview")
      : providerDisplayName(providerFilter);

  return (
    <SettingsPage
      title={t("stats.title")}
      description={t("stats.description")}
      contentClassName="space-y-5"
    >
      {summary.agentsSpawned === 0 && summary.chatsStarted === 0 ? (
        <div className="flex min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
          {t("stats.emptyTracking")}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label={t("stats.agentsSpawned")}
              value={summary.agentsSpawned.toLocaleString()}
              icon={<Bot className="size-4" />}
            />
            <StatCard
              label={t("stats.timeWorked")}
              value={workedLabel}
              icon={<Clock className="size-4" />}
            />
            <StatCard
              label={t("stats.chatsStarted")}
              value={summary.chatsStarted.toLocaleString()}
              icon={<MessageSquare className="size-4" />}
            />
          </div>
          {trackingSince ? (
            <p className="px-1 text-xs text-muted-foreground">
              {trackingSince}
            </p>
          ) : null}
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t("stats.usageAnalytics")}
          </h3>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t("stats.providerFilterAria", {
                    provider: activeProviderLabel,
                  })}
                  className="min-w-36 justify-between"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {providerFilter == null ? (
                      <BarChart3 className="size-3.5 text-muted-foreground" />
                    ) : (
                      (getProviderIcon(providerFilter, "size-3.5") ?? (
                        <BarChart3 className="size-3.5 text-muted-foreground" />
                      ))
                    )}
                    <span className="truncate">{activeProviderLabel}</span>
                  </span>
                  <ChevronDown
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => setProviderFilter(null)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <BarChart3 className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{t("stats.overview")}</span>
                  </span>
                  <Check
                    className={`ml-auto size-3.5 ${
                      providerFilter == null ? "opacity-100" : "opacity-0"
                    }`}
                    aria-hidden
                  />
                </DropdownMenuItem>
                {providerOptions.map((providerId) => (
                  <DropdownMenuItem
                    key={providerId}
                    onSelect={() => setProviderFilter(providerId)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {getProviderIcon(providerId, "size-3.5") ?? (
                        <BarChart3 className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {providerDisplayName(providerId)}
                      </span>
                    </span>
                    <Check
                      className={`ml-auto size-3.5 ${
                        providerFilter === providerId
                          ? "opacity-100"
                          : "opacity-0"
                      }`}
                      aria-hidden
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  aria-label={t("stats.refreshAria")}
                >
                  <RefreshCw
                    className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {t("stats.refresh")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <UsageOverviewPane
          ledger={ledger}
          enabledProviderIds={enabledProviderIds}
          providerFilter={providerFilter}
        />
      </div>
    </SettingsPage>
  );
}
