import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug, RefreshCw } from "lucide-react";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { cn } from "@/shared/lib/cn";
import {
  canConnectPlatform,
  connectAllAgentPlatforms,
  connectAgentPlatform,
  openProviderAccounts,
  openUsageDetails,
} from "../lib/connectPlatforms";
import {
  TRACKED_AGENT_PLATFORM_IDS,
  type AgentPlatformId,
  type ProviderRateLimits,
} from "../lib/rateLimitTypes";
import { isProviderVisible } from "../lib/rateLimitWindows";
import {
  startProviderRateLimitPolling,
  useProviderRateLimitsStore,
} from "../stores/providerRateLimitsStore";
import { ProviderSegment } from "./ProviderSegment";
import { StatusBarUsageEmptyCta } from "./StatusBarUsageEmptyCta";
import { UsageRosterPanel } from "./UsageRosterPanel";

function idleProvider(provider: AgentPlatformId): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: "idle",
    configured: false,
  };
}

export function StatusBar() {
  const { t } = useTranslation("status");
  const { agentReadiness } = useAgentProviderStatus();
  const snapshot = useProviderRateLimitsStore((state) => state.snapshot);
  const isRefreshing = useProviderRateLimitsStore(
    (state) => state.isRefreshing,
  );
  const usageMode = useProviderRateLimitsStore((state) => state.usageMode);
  const emptyCtaDismissed = useProviderRateLimitsStore(
    (state) => state.emptyCtaDismissed,
  );
  const refresh = useProviderRateLimitsStore((state) => state.refresh);
  const setUsageMode = useProviderRateLimitsStore(
    (state) => state.setUsageMode,
  );
  const dismissEmptyCta = useProviderRateLimitsStore(
    (state) => state.dismissEmptyCta,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => startProviderRateLimitPolling(), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const providers = useMemo(() => {
    const byId = new Map(
      (snapshot?.providers ?? []).map((provider) => [
        provider.provider,
        provider,
      ]),
    );
    return TRACKED_AGENT_PLATFORM_IDS.map(
      (providerId) => byId.get(providerId) ?? idleProvider(providerId),
    );
  }, [snapshot]);

  const visibleProviders = providers.filter(isProviderVisible);
  const connectable = TRACKED_AGENT_PLATFORM_IDS.filter((providerId) =>
    canConnectPlatform(providerId, agentReadiness.get(providerId)),
  );
  const isEmpty = visibleProviders.length === 0;

  return (
    <div
      data-testid="app-status-bar"
      role="status"
      aria-label={t("bar.aria")}
      className="flex h-7 shrink-0 items-center gap-1 border-t border-border/70 bg-background px-2 text-xs text-muted-foreground"
    >
      {isEmpty ? (
        emptyCtaDismissed ? null : (
          <StatusBarUsageEmptyCta
            onConnect={() => void connectAllAgentPlatforms(agentReadiness)}
            onHide={dismissEmptyCta}
          />
        )
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded px-1.5 py-0.5 text-left hover:bg-accent/70 hover:text-foreground"
              aria-label={t("roster.title")}
            >
              {visibleProviders.map((provider, index) => (
                <span
                  key={provider.provider}
                  className="inline-flex items-center gap-2"
                >
                  {index > 0 ? (
                    <span className="text-border" aria-hidden>
                      |
                    </span>
                  ) : null}
                  <ProviderSegment
                    provider={provider}
                    mode={usageMode}
                    now={now}
                  />
                </span>
              ))}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={6}
            className="p-0"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <UsageRosterPanel
              providers={
                visibleProviders.length > 0 ? visibleProviders : providers
              }
              usageMode={usageMode}
              isRefreshing={isRefreshing}
              now={now}
              onUsageModeChange={setUsageMode}
              onRefresh={() => void refresh()}
              onSignIn={(providerId) =>
                void connectAgentPlatform(
                  providerId,
                  agentReadiness.get(providerId),
                )
              }
              onUsageDetails={openUsageDetails}
              onManageAccounts={openProviderAccounts}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {connectable.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 inline-flex h-5 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              aria-label={t("bar.connectAll")}
            >
              <Plug className="size-3.5" />
              <span>{t("bar.connectAll")}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={6}
            className="w-56"
          >
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {t("bar.connectDescription")}
            </div>
            <DropdownMenuSeparator />
            {connectable.map((providerId) => (
              <DropdownMenuItem
                key={providerId}
                onSelect={() =>
                  void connectAgentPlatform(
                    providerId,
                    agentReadiness.get(providerId),
                  )
                }
                className="gap-2"
              >
                {getProviderIcon(providerId, "size-3.5")}
                <span className="flex-1">{t(`providers.${providerId}`)}</span>
                <span className="text-[11px] text-muted-foreground">
                  {t("bar.signIn")}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void connectAllAgentPlatforms(agentReadiness)}
            >
              <Plug className="size-3.5" />
              {t("bar.connectAll")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <button
        type="button"
        onClick={() => void refresh()}
        aria-label={t("bar.refresh")}
        className="ml-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/70 hover:text-foreground"
      >
        <RefreshCw className={cn("size-3", isRefreshing && "animate-spin")} />
      </button>
    </div>
  );
}
