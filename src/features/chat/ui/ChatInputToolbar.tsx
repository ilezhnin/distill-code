import { useMemo, useState } from "react";
import { ArrowUp, File, FolderOpen, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { useSessionCostPreference } from "@/features/chat/lib/sessionCostPreference";
import { IconCornerDownLeft, IconPlayerStopFilled } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { ContextRing } from "./ContextRing";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Progress } from "@/shared/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/shared/ui/tooltip";
import { AgentModelPicker } from "./AgentModelPicker";
import { ReasoningEffortPill } from "./ReasoningEffortPill";
import { resolveEffectiveReasoningEffort } from "../lib/effectiveReasoningEffort";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { getCatalogEntryFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { listVisibleAgentPickerOptions } from "../lib/listVisibleAgentPickerOptions";
import { ProjectInputSelector } from "./ProjectInputSelector";
import type { SessionRunSettingsNotice } from "../lib/sessionRunSettings";
import type {
  AgentPickerOption,
  ChatInputAgentModelPicker,
  ChatInputContextUsage,
  ChatInputFastMode,
  ChatInputProjectPicker,
  ChatInputReasoningEffort,
} from "../types";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";

interface ChatInputToolbarComposerActions {
  canSend: boolean;
  isStreaming: boolean;
  onSend: () => void;
  onStop?: () => void;
  /** Drops the composed message into the turn that is already running. */
  onSteer?: () => void;
  canSteer?: boolean;
  onAttachFiles?: () => void;
  onAttachFolders?: () => void;
  attachmentsEnabled?: boolean;
  disabled?: boolean;
  sendDisabledReason?: string;
}

type OpenToolbarMenu =
  | "attachments"
  | "model"
  | "effort"
  | "project"
  | "context";

interface ChatInputToolbarProps {
  agentModelPicker: ChatInputAgentModelPicker & { enabled?: boolean };
  reasoningEffort?: ChatInputReasoningEffort;
  fastMode?: ChatInputFastMode;
  runSettingsNotice?: SessionRunSettingsNotice | null;
  projectPicker: ChatInputProjectPicker;
  contextUsage: ChatInputContextUsage;
  composerActions: ChatInputToolbarComposerActions;
  onRequestComposerFocus?: () => void;
  isCompact: boolean;
}

export function ChatInputToolbar({
  agentModelPicker,
  reasoningEffort,
  fastMode,
  runSettingsNotice = null,
  projectPicker,
  contextUsage,
  composerActions,
  onRequestComposerFocus,
  isCompact,
}: ChatInputToolbarProps) {
  const { t } = useTranslation("chat");
  const { formatNumber } = useLocaleFormatting();
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const catalogLoaded = useProviderCatalogStore((state) => state.loaded);
  const { agentReadiness, readyAgentIds } = useAgentProviderStatus();
  const [openMenu, setOpenMenu] = useState<OpenToolbarMenu | null>(null);
  const handleMenuOpenChange = (menu: OpenToolbarMenu) => (open: boolean) => {
    setOpenMenu((current) => (open ? menu : current === menu ? null : current));
  };
  const isContextPopoverOpen = openMenu === "context";
  const {
    providers = [],
    providersLoading,
    selectedProvider = DEFAULT_HARNESS_ID,
    onProviderChange,
    currentModelId,
    currentModelProviderId,
    currentModel,
    availableModels = [],
    modelsLoading = false,
    modelStatusMessage = null,
    onModelChange,
    onPickerOpen,
    providerColumnMode,
    enabled: agentModelPickerEnabled = true,
  } = agentModelPicker;
  const {
    enabled: projectPickerEnabled = true,
    selectedProjectId = null,
    availableProjects = [],
    onProjectChange,
    onCreateProject,
  } = projectPicker;
  const {
    contextTokens = 0,
    contextLimit = 0,
    accumulatedCost = null,
    isContextUsageReady,
    supportsCompactionControls,
    canCompactContext = false,
    isCompactingContext = false,
    onCompactContext,
  } = contextUsage;
  const {
    canSend,
    isStreaming,
    onSend,
    onStop,
    onSteer,
    canSteer,
    onAttachFiles,
    onAttachFolders,
    attachmentsEnabled = true,
    disabled = false,
    sendDisabledReason,
  } = composerActions;
  const compactionControlsSupported = supportsCompactionControls ?? false;
  const sendButtonTooltip = canSend
    ? t("toolbar.sendMessage")
    : sendDisabledReason;

  const agentProviders = useMemo((): AgentPickerOption[] => {
    return listVisibleAgentPickerOptions({
      catalogEntries,
      catalogLoaded,
      agentReadiness,
      extraProviders: providers,
      selectedAgentId: selectedProvider,
      readyAgentIds,
    }).map((agent) => ({
      ...agent,
      label:
        getCatalogEntryFromEntries(catalogEntries, agent.id)?.displayName ??
        agent.label,
    }));
  }, [
    agentReadiness,
    catalogEntries,
    catalogLoaded,
    providers,
    readyAgentIds,
    selectedProvider,
  ]);
  const effectiveReasoning = useMemo(
    () =>
      resolveEffectiveReasoningEffort({
        sessionReasoningEffort: reasoningEffort,
      }),
    [reasoningEffort],
  );

  const contextProgress =
    contextLimit > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;
  const showContextUsage =
    (isContextUsageReady ?? contextLimit > 0) && contextTokens > 0;
  const contextPercentDigits =
    contextProgress > 0 && contextProgress < 0.1 ? 1 : 0;
  const usedPercentLabel = formatNumber(contextProgress, {
    style: "percent",
    minimumFractionDigits: contextPercentDigits,
    maximumFractionDigits: contextPercentDigits,
  });
  const formatCompactTokenCount = (value: number) =>
    formatNumber(value, {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: value < 10_000 ? 1 : 0,
    });
  const sessionCostPreference = useSessionCostPreference();
  const showSessionCost = sessionCostPreference.enabled;
  const hasCost =
    showSessionCost &&
    typeof accumulatedCost === "number" &&
    Number.isFinite(accumulatedCost);
  const formatCurrency = (value: number) =>
    formatNumber(value, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  // A nonzero cost that rounds below one cent (e.g. $0.004) would otherwise
  // render as "$0.00" and read as free. Show it as "<$0.01" so a real cost is
  // never displayed as zero.
  const costLabel = !hasCost
    ? null
    : (accumulatedCost as number) > 0 && (accumulatedCost as number) < 0.005
      ? `<${formatCurrency(0.01)}`
      : formatCurrency(accumulatedCost as number);

  const handleCompactContext = () => {
    if (!canCompactContext || isCompactingContext || !onCompactContext) {
      return;
    }

    setOpenMenu(null);
    void onCompactContext();
  };

  if (!showContextUsage && isContextPopoverOpen) {
    setOpenMenu(null);
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2",
        isCompact && "flex-wrap gap-y-2",
      )}
    >
      {/* Left side: pickers */}
      <div
        className={cn("flex min-w-0 items-center gap-2", isCompact && "flex-1")}
      >
        {attachmentsEnabled && (
          <DropdownMenu
            modal={false}
            open={openMenu === "attachments"}
            onOpenChange={handleMenuOpenChange("attachments")}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <ComposerActionButton
                    type="button"
                    size="icon-pill-sm"
                    disabled={disabled}
                    aria-label={t("toolbar.attach")}
                  >
                    <Plus aria-hidden="true" />
                  </ComposerActionButton>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("toolbar.attach")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => onAttachFiles?.()}
                disabled={disabled}
              >
                <File className="mr-2 h-4 w-4" />
                {t("toolbar.attachFile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onAttachFolders?.()}
                disabled={disabled}
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                {t("toolbar.attachFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {agentModelPickerEnabled &&
          (agentProviders.length > 0 || providersLoading) && (
            <AgentModelPicker
              agents={agentProviders}
              selectedAgentId={selectedProvider}
              onAgentChange={(providerId) => onProviderChange?.(providerId)}
              currentModelId={currentModelId}
              currentModelProviderId={currentModelProviderId}
              currentModelName={currentModel ?? null}
              availableModels={availableModels}
              modelsLoading={modelsLoading}
              modelStatusMessage={modelStatusMessage}
              onModelChange={onModelChange}
              fastMode={fastMode}
              runActive={isStreaming}
              runSettingsNotice={runSettingsNotice}
              open={openMenu === "model"}
              onOpen={onPickerOpen}
              onOpenChange={handleMenuOpenChange("model")}
              onRequestComposerFocus={onRequestComposerFocus}
              loading={providersLoading}
              isCompact={isCompact}
              triggerIconOnly={isCompact}
              providerColumnMode={providerColumnMode}
            />
          )}

        {agentModelPickerEnabled ? (
          <ReasoningEffortPill
            config={effectiveReasoning.config}
            onSelect={effectiveReasoning.onSelect}
            notice={runSettingsNotice}
            disabled={disabled}
            open={openMenu === "effort"}
            onOpenChange={handleMenuOpenChange("effort")}
          />
        ) : null}

        {projectPickerEnabled ? (
          <ProjectInputSelector
            selectedProjectId={selectedProjectId}
            availableProjects={availableProjects}
            onProjectChange={onProjectChange}
            onCreateProject={onCreateProject}
            open={openMenu === "project"}
            onOpenChange={handleMenuOpenChange("project")}
            onRequestComposerFocus={onRequestComposerFocus}
            modal={false}
            triggerIconOnly={isCompact}
          />
        ) : null}
      </div>

      {/* Right side: actions */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          isCompact && "ml-auto",
        )}
      >
        <div className="flex items-center gap-2">
          {showContextUsage && (
            <Popover
              open={isContextPopoverOpen}
              onOpenChange={handleMenuOpenChange("context")}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size={isCompact ? "icon-sm" : "sm"}
                      className={cn(
                        "group rounded-sm bg-transparent text-foreground/80 shadow-none hover:bg-transparent hover:text-foreground data-[state=open]:bg-transparent data-[state=open]:text-foreground",
                        isCompact ? "px-0" : "px-2.5",
                      )}
                      aria-label={
                        costLabel
                          ? t("toolbar.contextUsageWithCost", {
                              cost: costLabel,
                            })
                          : t("toolbar.contextUsage")
                      }
                    >
                      <ContextRing
                        tokens={contextTokens}
                        limit={contextLimit}
                        size={16}
                      />
                      {!isCompact && costLabel ? (
                        <span className="ml-1.5 text-xs tabular-nums">
                          {costLabel}
                        </span>
                      ) : null}
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  {t("toolbar.contextUsageTitle", {
                    tokens: formatNumber(contextTokens),
                    limit: formatNumber(contextLimit),
                  })}
                </TooltipContent>
              </Tooltip>
              <PopoverContent
                side="top"
                align="end"
                sideOffset={8}
                className="w-60 rounded-md p-1 text-left"
              >
                <div className="px-2 py-1.5 text-sm font-semibold text-foreground">
                  {t("toolbar.contextWindow")}
                </div>
                <div className="space-y-2 px-2 pb-1.5">
                  <Progress
                    className="h-1.5 bg-muted"
                    value={contextProgress * 100}
                  />
                  <div className="flex items-center justify-between gap-3 text-xs text-foreground">
                    <div className="truncate">
                      {t("toolbar.contextTokensBreakdown", {
                        tokens: formatCompactTokenCount(contextTokens),
                        limit: formatCompactTokenCount(contextLimit),
                      })}
                    </div>
                    <div className="shrink-0">{usedPercentLabel}</div>
                  </div>
                  {costLabel ? (
                    <div className="flex items-center justify-between gap-3 text-xs text-foreground">
                      <div className="truncate text-muted-foreground">
                        {t("toolbar.sessionCost")}
                      </div>
                      <div className="shrink-0 tabular-nums">{costLabel}</div>
                    </div>
                  ) : null}
                  {compactionControlsSupported ? (
                    <div className="flex items-center gap-1 pt-0.5">
                      <Button
                        type="button"
                        variant="subtle"
                        size="xs"
                        className="min-w-0 flex-1 justify-center"
                        onClick={handleCompactContext}
                        disabled={!canCompactContext || isCompactingContext}
                      >
                        {isCompactingContext
                          ? t("toolbar.compacting")
                          : t("toolbar.compactNow")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        <div className="flex items-center gap-1">
          {isStreaming && canSteer && onSteer ? (
            // While a turn is running the send button is a stop button, which
            // leaves no way to say the next thing without first parking it in
            // the queue. This is that way: it puts the composed message into
            // the running turn, and it is only offered where the harness can
            // actually take one.
            <ComposerActionButton
              type="button"
              onClick={onSteer}
              size="icon-pill-sm"
              aria-label={t("toolbar.steer")}
              tooltip={t("toolbar.steerNow")}
            >
              <IconCornerDownLeft className="size-3.5" aria-hidden="true" />
            </ComposerActionButton>
          ) : null}
          {isStreaming && onStop ? (
            <ComposerActionButton
              type="button"
              onClick={onStop}
              size="icon-pill-sm"
              aria-label={t("toolbar.stopGeneration")}
              tooltip={t("toolbar.stopGeneration")}
            >
              <IconPlayerStopFilled className="size-3.5" aria-hidden="true" />
            </ComposerActionButton>
          ) : !sendButtonTooltip ? (
            <ComposerActionButton
              type="button"
              onClick={onSend}
              disabled={!canSend}
              size="icon-pill-sm"
              className={cn(!canSend && "disabled:opacity-100")}
              aria-label={t("toolbar.sendMessage")}
            >
              <ArrowUp aria-hidden="true" />
            </ComposerActionButton>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <ComposerActionButton
                    type="button"
                    onClick={onSend}
                    disabled={!canSend}
                    size="icon-pill-sm"
                    className={cn(!canSend && "disabled:opacity-100")}
                    aria-label={sendButtonTooltip ?? t("toolbar.sendMessage")}
                  >
                    <ArrowUp aria-hidden="true" />
                  </ComposerActionButton>
                </span>
              </TooltipTrigger>
              {sendButtonTooltip ? (
                <TooltipContent>{sendButtonTooltip}</TooltipContent>
              ) : null}
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
