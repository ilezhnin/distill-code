import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { hasCompletedSignIn } from "@/features/providers/lib/providerConnections";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";
import {
  connectAgentPlatform,
  openProviderAccounts,
  openUsageDetails,
} from "../lib/connectPlatforms";
import { buildProviderStatuses } from "../lib/providerStatus";
import { isListedUsageProvider } from "../lib/rateLimitWindows";
import {
  startProviderRateLimitPolling,
  useProviderRateLimitsStore,
} from "../stores/providerRateLimitsStore";
import { ProviderSegment } from "./ProviderSegment";
import { StatusBarUsageEmptyCta } from "./StatusBarUsageEmptyCta";
import { UsageRosterPanel } from "./UsageRosterPanel";

export function StatusBar() {
  const { t } = useTranslation("status");
  const { agentReadiness } = useAgentProviderStatus();
  const providerModels = useProviderAccountsStore(
    (state) => state.providersById,
  );
  const catalog = useProviderCatalogStore((state) => state.entries);
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
  const providers = useMemo(
    () => buildProviderStatuses(catalog, snapshot?.providers, agentReadiness),
    [catalog, snapshot, agentReadiness],
  );
  // A provider pause counts down by the second; otherwise a slow tick keeps
  // reset times and "updated" labels fresh.
  const paused = providers.some((provider) => provider.usageRetryAt != null);
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      paused ? 1_000 : 30_000,
    );
    return () => window.clearInterval(timer);
  }, [paused]);

  const visibleProviders = providers.filter((provider) =>
    isListedUsageProvider(
      provider,
      agentReadiness.get(provider.provider),
      hasCompletedSignIn(provider.provider, providerModels[provider.provider]),
    ),
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
            onConnect={openProviderAccounts}
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
