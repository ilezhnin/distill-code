import { ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";
import type {
  AgentPlatformId,
  ProviderRateLimits,
  StatusBarUsageMode,
} from "../lib/rateLimitTypes";
import {
  barColorClass,
  clampUsedPercent,
  getUsageSections,
  providerMaxUsed,
  remainingDurationLabel,
} from "../lib/rateLimitWindows";
import {
  formatUsedPercent,
  getProviderUsageStatusKind,
  resetDuration,
} from "../lib/rateLimitFormatters";
import { ProviderDetailsPanel } from "./ProviderDetailsPanel";

function UsageMetric({
  label,
  usedPercent,
  showBar,
}: {
  label: string;
  usedPercent: number;
  showBar: boolean;
}) {
  const used = clampUsedPercent(usedPercent);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {showBar ? (
        <span className="h-[5px] w-7 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full", barColorClass(used))}
            style={{ width: `${used}%` }}
          />
        </span>
      ) : null}
      <span
        className={cn(
          "tabular-nums text-[11px]",
          used >= 80 ? "text-red-500" : "text-foreground",
        )}
      >
        {formatUsedPercent(used)}
      </span>
    </span>
  );
}

function UsageRow({
  provider,
  mode,
  now,
  showSignIn,
}: {
  provider: ProviderRateLimits;
  mode: StatusBarUsageMode;
  now: number;
  showSignIn: boolean;
}) {
  const { t } = useTranslation("status");
  const sections = getUsageSections(provider);
  const name = t(`providers.${provider.provider}`);
  const statusKind = getProviderUsageStatusKind(provider);
  const resetRaw = resetDuration(
    sections
      .map((section) => section.window.resetsAt)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right)[0],
    now,
  );
  const reset =
    resetRaw == null
      ? null
      : resetRaw === "now"
        ? t("roster.resetsNow")
        : t("roster.resetsIn", { duration: resetRaw });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          {getProviderIcon(provider.provider, "size-3.5")}
        </span>
        <span className="min-w-0 shrink truncate text-[13px] font-medium text-foreground">
          {name}
          {provider.planType ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {provider.planType}
            </span>
          ) : null}
        </span>
        {sections.length === 0 ? (
          <>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {statusKind === "refresh-failed"
                ? t("bar.refreshFailed")
                : t("roster.signInToSee")}
            </span>
            {showSignIn ? (
              <span className="ml-auto shrink-0 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground">
                {t("bar.signIn")}
              </span>
            ) : null}
          </>
        ) : mode === "compact" ? (
          <span className="ml-auto">
            <UsageMetric
              label={remainingDurationLabel(
                sections.reduce((current, candidate) =>
                  clampUsedPercent(candidate.window.usedPercent) >
                  clampUsedPercent(current.window.usedPercent)
                    ? candidate
                    : current,
                ).window,
                now,
              )}
              usedPercent={providerMaxUsed(provider)}
              showBar={false}
            />
          </span>
        ) : reset ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {reset}
          </span>
        ) : null}
      </div>
      {sections.length > 0 && mode === "verbose" ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[30px]">
          {sections.map((section) => (
            <UsageMetric
              key={section.key}
              label={
                section.key === "session"
                  ? remainingDurationLabel(section.window, now)
                  : section.shortLabel
              }
              usedPercent={section.window.usedPercent}
              showBar
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function UsageRosterPanel({
  providers,
  usageMode,
  isRefreshing,
  now = Date.now(),
  onUsageModeChange,
  onRefresh,
  onSignIn,
  onUsageDetails,
  onManageAccounts,
}: {
  providers: ProviderRateLimits[];
  usageMode: StatusBarUsageMode;
  isRefreshing: boolean;
  now?: number;
  onUsageModeChange: (mode: StatusBarUsageMode) => void;
  onRefresh: () => void;
  onSignIn: (providerId: AgentPlatformId) => void;
  onUsageDetails: () => void;
  onManageAccounts: () => void;
}) {
  const { t } = useTranslation("status");
  const sorted = [...providers].sort(
    (left, right) => providerMaxUsed(right) - providerMaxUsed(left),
  );

  return (
    <div className="w-[360px] text-xs">
      <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
        <span className="text-[13px] font-semibold text-foreground">
          {t("roster.title")}
        </span>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="text-[11px]">{t("roster.allAgents")}</span>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onRefresh();
            }}
            aria-label={t("bar.refresh")}
            className="size-5 justify-center p-0"
          >
            <RefreshCw
              className={cn("size-3", isRefreshing && "animate-spin")}
            />
          </DropdownMenuItem>
        </div>
      </div>
      <div className="px-3.5 pb-2.5">
        <div className="inline-flex w-full rounded-md border border-border bg-muted p-0.5">
          {(["verbose", "compact"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={usageMode === mode}
              onClick={() => onUsageModeChange(mode)}
              className={cn(
                "min-w-0 flex-1 rounded-sm px-2 py-1 text-center text-xs outline-none",
                usageMode === mode
                  ? "bg-background font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "verbose" ? t("roster.detailed") : t("roster.compact")}
            </button>
          ))}
        </div>
      </div>
      <DropdownMenuSeparator />
      {sorted.map((provider) => {
        const statusKind = getProviderUsageStatusKind(provider);
        const showSignIn = statusKind === "sign-in";
        const row = (
          <UsageRow
            provider={provider}
            mode={usageMode}
            now={now}
            showSignIn={showSignIn}
          />
        );
        if (showSignIn) {
          return (
            <DropdownMenuItem
              key={provider.provider}
              onSelect={() => onSignIn(provider.provider)}
              className="w-full cursor-pointer rounded-none px-3.5 py-2.5"
            >
              {row}
            </DropdownMenuItem>
          );
        }
        return (
          <DropdownMenuSub key={provider.provider}>
            <DropdownMenuSubTrigger className="w-full cursor-pointer rounded-none px-3.5 py-2.5">
              {row}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="p-0" sideOffset={6}>
              <ProviderDetailsPanel provider={provider} now={now} />
              {provider.accountLabel ? (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">
                      {t("roster.account", {
                        name: t(`providers.${provider.provider}`),
                      })}
                    </div>
                    <div className="truncate text-[13px] text-foreground">
                      {provider.accountLabel}
                    </div>
                  </div>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onManageAccounts}
                className="justify-between px-3.5 py-2.5 text-[13px]"
              >
                {t("roster.manageAccounts")}
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={onUsageDetails}
        className="w-full cursor-pointer justify-between rounded-none px-3.5 py-2.5 text-[13px]"
      >
        {t("roster.usageDetails")}
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={onManageAccounts}
        className="w-full cursor-pointer justify-between rounded-none px-3.5 py-2.5 text-[13px]"
      >
        {t("roster.manageAccounts")}
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </DropdownMenuItem>
    </div>
  );
}
