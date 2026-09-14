import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  IconAiAgents,
  IconArrowsExchange,
  IconCheck,
  IconChevronDown,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useComposerPickerCloseFocus } from "@/features/chat/hooks/useComposerPickerCloseFocus";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Spinner } from "@/shared/ui/spinner";
import { Switch } from "@/shared/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  formatProviderLabel,
  getProviderIcon,
} from "@/shared/ui/icons/ProviderIcons";
import {
  resolveDisplayModelLabel,
  resolvePickerTriggerLabel,
} from "../lib/modelDisplayLabel";
import { toSentenceCaseLabel } from "../lib/effectiveReasoningEffort";
import { hideAliasTwins } from "../lib/modelAliases";
import type { SessionRunSettingsNotice } from "../lib/sessionRunSettings";
import type {
  AgentPickerOption,
  ChatInputFastMode,
  ModelOption,
} from "../types";
import {
  ModelList,
  MoreModelList,
  isMoreModel,
  modelMatchesSelection,
  type ModelListHandle,
} from "./AgentModelPickerLists";
import { PickerItem } from "./AgentModelPickerItem";

interface AgentModelPickerProps {
  agents: AgentPickerOption[];
  selectedAgentId: string;
  onAgentChange: (agentId: string) => void;
  currentModelId?: string | null;
  currentModelProviderId?: string | null;
  currentModelName?: string | null;
  availableModels: ModelOption[];
  modelsLoading?: boolean;
  modelStatusMessage?: string | null;
  onModelChange?: (modelId: string, model?: ModelOption) => void;
  /**
   * The current model's fast toggle. The row shows only when that model has
   * fast mode: a live `config`, or before a session the model row's own
   * `supportsFast === true`.
   */
  fastMode?: ChatInputFastMode;
  /** A turn is running, so models that reopen the session are unavailable. */
  runActive?: boolean;
  /** Why the current model is not running at the operator's chosen value. */
  runSettingsNotice?: SessionRunSettingsNotice | null;
  loading?: boolean;
  isCompact?: boolean;
  showSelectedModelInTrigger?: boolean;
  triggerTabIndex?: number;
  triggerIconOnly?: boolean;
  open?: boolean;
  onOpen?: () => void;
  onOpenChange?: (open: boolean) => void;
  onRequestComposerFocus?: () => void;
  contentAlign?: PopoverContentAlign | "smart";
  contentCollisionPadding?: number;
  providerColumnMode?: ProviderColumnMode;
}

/**
 * In existing sessions a provider switch can recreate the session, so the
 * column is gated behind an explicit reveal instead of sitting next to the
 * model list. New-chat composers keep it always visible.
 */
type ProviderColumnMode = "visible" | "gated";
type PopoverContentAlign = NonNullable<
  ComponentProps<typeof PopoverContent>["align"]
>;
const PICKER_WIDTH_PX = 420;
const NAV_ITEM_SELECTOR = "button[data-picker-nav-item]:not(:disabled)";

export function AgentModelPicker({
  agents,
  selectedAgentId,
  onAgentChange,
  currentModelId = null,
  currentModelProviderId = null,
  currentModelName = null,
  availableModels,
  modelsLoading = false,
  modelStatusMessage = null,
  onModelChange,
  fastMode,
  runActive = false,
  runSettingsNotice = null,
  loading = false,
  isCompact = false,
  showSelectedModelInTrigger = true,
  triggerTabIndex,
  triggerIconOnly = false,
  open: controlledOpen,
  onOpen,
  onOpenChange,
  onRequestComposerFocus,
  contentAlign = "start",
  contentCollisionPadding = 16,
  providerColumnMode = "visible",
}: AgentModelPickerProps) {
  const { t } = useTranslation("chat");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fastSwitchId = useId();
  const {
    beginOpenCycle,
    preserveFocusDestination,
    classifyOutsideInteraction,
    handleCloseAutoFocus,
  } = useComposerPickerCloseFocus({
    triggerRef,
    onRequestComposerFocus,
  });
  const modelListRef = useRef<ModelListHandle>(null);
  const [providerRevealed, setProviderRevealed] = useState(false);
  const [modelBrowsing, setModelBrowsing] = useState(false);
  // What the operator did with the "More models" page during this open cycle.
  // Until they touch it the page follows the selection, which is what lets a
  // chat on an older model open straight onto that page with the row focused.
  const [moreRevealedChoice, setMoreRevealedChoice] = useState<boolean | null>(
    null,
  );
  const moreFocusDestinationRef = useRef<"more" | "trigger" | null>(null);
  const [resolvedContentAlign, setResolvedContentAlign] =
    useState<PopoverContentAlign>("start");
  const selectedAgentLabel =
    agents.find((agent) => agent.id === selectedAgentId)?.label ??
    formatProviderLabel(selectedAgentId);
  // The model id is the model and nothing else: effort travels on the
  // session's own config option, so the list is shown as the harness sent it.
  const pickerModels = useMemo(
    () => hideAliasTwins(availableModels, currentModelId),
    [availableModels, currentModelId],
  );
  const displayModelLabel = resolveDisplayModelLabel({
    currentModelId,
    currentModelName,
    currentModelProviderId,
    availableModels: pickerModels,
  });
  const displayedModels = useMemo(() => {
    const currentModelBelongsToSelectedAgent =
      currentModelProviderId === selectedAgentId;
    if (
      !currentModelId ||
      !displayModelLabel ||
      !currentModelBelongsToSelectedAgent
    ) {
      return pickerModels;
    }

    const hasCurrentModel = pickerModels.some(
      (model) =>
        model.id === currentModelId &&
        (!currentModelProviderId ||
          !model.providerId ||
          model.providerId === currentModelProviderId),
    );
    if (hasCurrentModel) {
      return pickerModels;
    }

    return [
      {
        id: currentModelId,
        name: displayModelLabel,
        displayName: displayModelLabel,
        providerId: currentModelProviderId ?? undefined,
        providerName: currentModelProviderId
          ? formatProviderLabel(currentModelProviderId)
          : undefined,
        recommended: true,
        featured: false,
        // Filed on the main page explicitly: this row exists to show the
        // current model, so it must never sit behind "More models".
        group: "main" as const,
      },
      ...pickerModels,
    ];
  }, [
    currentModelId,
    currentModelProviderId,
    displayModelLabel,
    pickerModels,
    selectedAgentId,
  ]);
  const triggerLabel = showSelectedModelInTrigger
    ? resolvePickerTriggerLabel({
        currentModelId,
        currentModelName: displayModelLabel,
        currentModelProviderId,
        availableModels: displayedModels,
        selectedAgentLabel,
      })
    : selectedAgentLabel;
  const triggerTitle =
    triggerLabel ?? (loading ? t("toolbar.loading") : undefined);
  const triggerButtonSize = triggerIconOnly ? "icon-pill-sm" : "sm";
  const triggerProviderIcon =
    getProviderIcon(selectedAgentId, "size-4") ??
    (triggerIconOnly ? <IconAiAgents className="size-4" /> : null);
  const handleAgentSelect = (agent: AgentPickerOption) => {
    if (agent.readiness && agent.readiness !== "ready") {
      preserveFocusDestination();
      requestOpenSettings("providers");
      setOpen(false);
      return;
    }

    if (agent.id !== selectedAgentId) {
      onAgentChange(agent.id);
    }
  };

  const handleModelSelect = (model: ModelOption) => {
    onModelChange?.(model.id, model);
  };

  const currentModelOption = useMemo(
    () =>
      displayedModels.find((model) =>
        modelMatchesSelection(model, currentModelId, currentModelProviderId),
      ) ?? null,
    [currentModelId, currentModelProviderId, displayedModels],
  );
  const hasMoreModels =
    !modelsLoading &&
    displayedModels.length > 0 &&
    displayedModels.some(isMoreModel);
  const selectionInMore =
    currentModelOption != null && isMoreModel(currentModelOption);
  // Search shows both pages as one flat list, so the page itself steps aside.
  const moreRevealed =
    hasMoreModels && !modelBrowsing && (moreRevealedChoice ?? selectionInMore);
  const setMoreRevealed = useCallback(
    (reveal: boolean) => {
      if (reveal === moreRevealed) {
        return;
      }
      moreFocusDestinationRef.current = reveal ? "more" : "trigger";
      setMoreRevealedChoice(reveal);
    },
    [moreRevealed],
  );

  // Re-gate the provider column and hand the "More models" page back to the
  // selection when the popover closes, so every reopen starts from the layout
  // the current model calls for.
  useEffect(() => {
    if (!open) {
      setProviderRevealed(false);
      setModelBrowsing(false);
      setMoreRevealedChoice(null);
      moreFocusDestinationRef.current = null;
    }
  }, [open]);

  // The more column is for choosing an older model; the agent column beside it
  // would leave neither enough width, so it steps aside until "Back".
  const showAgentColumn =
    (providerColumnMode === "visible" || providerRevealed) && !moreRevealed;
  // A sole ready agent leaves nothing to reveal, but a sole not-ready agent
  // still needs the footer: the hidden column's Connect/Install row is the
  // only setup path from this picker.
  const hasAgentNeedingSetup = agents.some(
    (agent) => agent.readiness && agent.readiness !== "ready",
  );
  // Searching or browsing older models is a model-picking task; the reveal
  // button would swap the whole popover out from under it.
  const showSwitchProviderFooter =
    providerColumnMode === "gated" &&
    !providerRevealed &&
    !modelBrowsing &&
    !moreRevealed &&
    (agents.length > 1 || hasAgentNeedingSetup);

  // Land keyboard focus in the revealed column, since the reveal button that
  // held focus unmounts with it.
  useEffect(() => {
    if (!providerRevealed) {
      return;
    }

    const agentColumn = contentRef.current?.querySelector('[data-col="agent"]');
    const target =
      agentColumn?.querySelector<HTMLElement>("button[data-selected]") ??
      agentColumn?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [providerRevealed]);

  // Opening the page moves focus onto it (the selected row, else its first
  // model row); leaving it puts focus back on "More models". A reveal that
  // follows the selection on open is left to `onOpenAutoFocus`.
  useEffect(() => {
    const destination = moreFocusDestinationRef.current;
    if (!destination) {
      return;
    }
    moreFocusDestinationRef.current = null;

    const content = contentRef.current;
    if (destination === "more" && moreRevealed) {
      const moreColumn = content?.querySelector('[data-col="more"]');
      const target =
        moreColumn?.querySelector<HTMLElement>(
          "button[data-selected]:not(:disabled)",
        ) ??
        moreColumn?.querySelector<HTMLElement>(
          "button[data-picker-nav-item]:not([data-picker-back]):not(:disabled)",
        ) ??
        moreColumn?.querySelector<HTMLElement>(NAV_ITEM_SELECTOR);
      target?.focus();
    } else if (destination === "trigger" && !moreRevealed) {
      content
        ?.querySelector<HTMLElement>("button[data-picker-more-trigger]")
        ?.focus();
    }
  }, [moreRevealed]);

  const resolveContentAlign = useCallback((): PopoverContentAlign => {
    if (contentAlign !== "smart") {
      return contentAlign;
    }

    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!triggerRect) {
      return "start";
    }

    const leftAlignedRightEdge = triggerRect.left + PICKER_WIDTH_PX;
    return leftAlignedRightEdge <= window.innerWidth - contentCollisionPadding
      ? "start"
      : "center";
  }, [contentAlign, contentCollisionPadding]);

  useEffect(() => {
    if (open) {
      setResolvedContentAlign(resolveContentAlign());
    }
  }, [open, resolveContentAlign]);

  const liveFastMode = fastMode?.config;
  // A visible toggle on a model without fast mode answers
  // `Unknown config option: fast`, so availability is the model's own: the live
  // option once a session reports one, the inventory row before that.
  const showFastModeRow =
    fastMode?.onChange != null &&
    (liveFastMode != null || currentModelOption?.supportsFast === true);
  const fastModeEnabled = liveFastMode?.enabled ?? fastMode?.desired ?? false;
  const fastModeLabel =
    toSentenceCaseLabel(liveFastMode?.name) || t("toolbar.fastMode");
  const noticeModelName =
    runSettingsNotice?.modelName || displayModelLabel || t("toolbar.model");
  // An effort the model runs at a different stop is explained under the effort
  // control; these two have no control of their own to sit under, because the
  // model offers no fast mode or no effort at all.
  const modelNoticeText =
    runSettingsNotice?.kind === "fast"
      ? t("toolbar.fastUnavailable", { model: noticeModelName })
      : runSettingsNotice?.kind === "effort" && runSettingsNotice.actual == null
        ? t("toolbar.effortControlUnavailable", { model: noticeModelName })
        : null;
  const modelColumnFooter =
    showFastModeRow || modelNoticeText ? (
      <div className="shrink-0 border-t px-1 pt-1">
        {showFastModeRow ? (
          <div className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm">
            <label htmlFor={fastSwitchId} className="min-w-0 flex-1 truncate">
              {fastModeLabel}
            </label>
            <Switch
              id={fastSwitchId}
              data-picker-nav-item
              checked={fastModeEnabled}
              onCheckedChange={(enabled) => fastMode?.onChange?.(enabled)}
              title={
                fastModeEnabled
                  ? t("toolbar.fastModeDisable", { name: fastModeLabel })
                  : t("toolbar.fastModeEnable", { name: fastModeLabel })
              }
            />
          </div>
        ) : null}
        {modelNoticeText ? (
          <p
            role="status"
            className="px-2 py-1.5 text-xs text-muted-foreground"
          >
            {modelNoticeText}
          </p>
        ) : null}
      </div>
    ) : null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          beginOpenCycle();
          setResolvedContentAlign(resolveContentAlign());
        }
        setOpen(nextOpen);
        if (nextOpen) onOpen?.();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ComposerActionButton
              ref={triggerRef}
              type="button"
              size={triggerButtonSize}
              aria-label={t("toolbar.chooseAgentModel")}
              tabIndex={triggerTabIndex}
              disabled={loading && !selectedAgentLabel}
              leftIcon={triggerProviderIcon}
              rightIcon={
                triggerIconOnly ? undefined : (
                  <IconChevronDown className="opacity-50" />
                )
              }
              className={cn(
                "chat-composer-selector-trigger group",
                triggerIconOnly ? "shrink-0" : "min-w-0 max-w-full",
              )}
            >
              {triggerIconOnly ? null : (
                <span
                  className={cn(
                    "chat-composer-selector-label flex min-w-0 items-baseline gap-1.5 truncate",
                    isCompact ? "max-w-32" : "max-w-56",
                  )}
                >
                  <span className="min-w-0 truncate">
                    {triggerLabel ?? (loading ? t("toolbar.loading") : null)}
                  </span>
                </span>
              )}
            </ComposerActionButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{triggerTitle}</TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        align={resolvedContentAlign}
        collisionPadding={contentCollisionPadding}
        className={cn(
          // Fit the content up to the cap instead of pinning the height, so the
          // gated single-column layout has no dead vertical space below the
          // model list.
          "flex max-h-[min(24rem,50vh)] w-[26.25rem] flex-col overflow-hidden p-1",
        )}
        onInteractOutside={(event) => {
          classifyOutsideInteraction(event.target);
        }}
        onCloseAutoFocus={handleCloseAutoFocus}
        onOpenAutoFocus={(e) => {
          // Prefer the selected row of the first visible column, then that
          // column's first enabled row, then the reveal footer. Without the
          // fallbacks a gated picker with no selected model (loading, empty,
          // or nothing chosen yet) would leave focus on the trigger, where the
          // arrow-key handler below never engages. An older selection opens
          // the more column with its row selected, and the model column then
          // holds no selected row, so the first match is that one.
          const content = contentRef.current;
          const visibleColumn = "[data-col]:not([data-hidden='true'])";
          const target =
            content?.querySelector<HTMLElement>(
              `${visibleColumn} button[data-selected]:not(:disabled)`,
            ) ??
            content?.querySelector<HTMLElement>(
              `${visibleColumn} ${NAV_ITEM_SELECTOR}`,
            ) ??
            content?.querySelector<HTMLElement>(
              "button[data-picker-footer-action]:not(:disabled)",
            );
          // Nothing focusable: leave Radix's default content focus in place so
          // keyboard users still land inside the popover.
          if (!target) {
            return;
          }

          e.preventDefault();
          target.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (modelListRef.current?.closeOverlay()) {
            e.preventDefault();
          }
        }}
        onKeyDown={(e) => {
          const active = document.activeElement as HTMLElement | null;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const col = active?.closest("[data-col]");
            if (!col) return;
            const items = Array.from(
              col.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR),
            );
            const idx = items.indexOf(active as HTMLElement);
            const next =
              idx < 0
                ? e.key === "ArrowDown"
                  ? items[0]
                  : items[items.length - 1]
                : e.key === "ArrowDown"
                  ? items[(idx + 1) % items.length]
                  : items[(idx - 1 + items.length) % items.length];
            next?.focus();
          } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            // "More models" and its page behave like a submenu: Right opens it,
            // Left from inside it returns to the row that opened it.
            if (
              e.key === "ArrowRight" &&
              !moreRevealed &&
              active?.hasAttribute("data-picker-more-trigger")
            ) {
              setMoreRevealed(true);
              return;
            }
            if (e.key === "ArrowLeft" && active?.closest('[data-col="more"]')) {
              setMoreRevealed(false);
              return;
            }
            const content = e.currentTarget as HTMLElement;
            const cols = Array.from(
              content.querySelectorAll<HTMLElement>(
                "[data-col]:not([data-hidden='true'])",
              ),
            );
            const currentCol = active?.closest("[data-col]");
            const colIdx = cols.indexOf(currentCol as HTMLElement);
            const targetCol =
              e.key === "ArrowRight"
                ? cols[(colIdx + 1) % cols.length]
                : cols[(colIdx - 1 + cols.length) % cols.length];
            if (!targetCol) return;
            const targetItems = Array.from(
              targetCol.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR),
            );
            const currentItems = Array.from(
              currentCol?.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR) ??
                [],
            );
            const currentIdx = currentItems.indexOf(active as HTMLElement);
            const target =
              targetItems[Math.min(currentIdx, targetItems.length - 1)] ??
              targetItems[0];
            target?.focus();
          }
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 items-stretch overflow-hidden">
            {/* Agent column — collapsed while gated */}
            <div
              data-col="agent"
              data-hidden={!showAgentColumn}
              aria-hidden={!showAgentColumn}
              className={cn(
                "min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)]",
                showAgentColumn
                  ? "w-[11.75rem] opacity-100"
                  : "pointer-events-none w-0 opacity-0",
              )}
            >
              <div className="flex h-full w-[11.75rem] min-w-0 p-1">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
                    {t("toolbar.agent")}
                  </div>
                  <ScrollArea className="min-h-0 min-w-0 flex-1">
                    <div className="space-y-0.5 p-1">
                      {agents.map((agent) => {
                        const isSelected = agent.id === selectedAgentId;
                        const isReady =
                          !agent.readiness || agent.readiness === "ready";
                        const setupLabel =
                          agent.setupAction === "install"
                            ? t("toolbar.install")
                            : t("toolbar.connect");
                        const agentIcon = getProviderIcon(agent.id, "size-4");

                        return (
                          <PickerItem
                            key={agent.id}
                            onClick={() => handleAgentSelect(agent)}
                            selected={isSelected}
                            tabIndex={showAgentColumn ? undefined : -1}
                            className={cn(
                              "group justify-between",
                              !isReady &&
                                "opacity-40 hover:opacity-100 focus-visible:opacity-100",
                            )}
                          >
                            {agentIcon ? (
                              <span className="shrink-0">{agentIcon}</span>
                            ) : null}
                            <span className="min-w-0 flex-1 truncate">
                              {agent.label}
                            </span>
                            {!isReady ? (
                              <Button
                                asChild
                                variant="outline"
                                size="xxs"
                                className="pointer-events-none shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                              >
                                <span>{setupLabel}</span>
                              </Button>
                            ) : isSelected ? (
                              <IconCheck className="size-4 shrink-0 text-muted-foreground" />
                            ) : null}
                          </PickerItem>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>

            {/* Model column */}
            <div
              data-col="model"
              className={cn(
                "flex min-h-0 min-w-0 overflow-hidden p-1",
                showAgentColumn
                  ? "ml-1 w-56 shrink-0"
                  : moreRevealed
                    ? "w-56 shrink-0"
                    : "flex-1",
              )}
            >
              {modelsLoading ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
                    {t("toolbar.model")}
                  </div>
                  {displayModelLabel ? (
                    <div className="space-y-0.5 p-1">
                      <PickerItem selected disabled>
                        <div className="min-w-0 flex-1 truncate">
                          {displayModelLabel}
                        </div>
                        <Spinner className="size-3.5 shrink-0" />
                      </PickerItem>
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                      <Spinner className="size-4" />
                      <span>{t("toolbar.loadingModels")}</span>
                    </div>
                  )}
                </div>
              ) : displayedModels.length > 0 ? (
                <ModelList
                  key={selectedAgentId}
                  ref={modelListRef}
                  models={displayedModels}
                  currentModelId={currentModelId}
                  currentModelProviderId={currentModelProviderId}
                  runActive={runActive}
                  moreOpen={moreRevealed}
                  onMoreOpenChange={setMoreRevealed}
                  onModelSelect={handleModelSelect}
                  onBrowseChange={setModelBrowsing}
                  footer={modelColumnFooter}
                />
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
                    {t("toolbar.model")}
                  </div>
                  <div className="px-2 py-2">
                    <div className="text-sm text-muted-foreground">
                      {modelStatusMessage ??
                        displayModelLabel ??
                        t("toolbar.noModelsAvailable")}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* More models column — collapsed until opened */}
            {hasMoreModels ? (
              <div
                data-col="more"
                data-hidden={!moreRevealed}
                aria-hidden={!moreRevealed}
                className={cn(
                  "min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)]",
                  moreRevealed
                    ? "ml-1 w-[11.75rem] opacity-100"
                    : "pointer-events-none w-0 opacity-0",
                )}
              >
                <div className="flex h-full w-[11.75rem] min-w-0 p-1">
                  <MoreModelList
                    models={displayedModels}
                    currentModelId={currentModelId}
                    currentModelProviderId={currentModelProviderId}
                    runActive={runActive}
                    hidden={!moreRevealed}
                    onBack={() => setMoreRevealed(false)}
                    onModelSelect={handleModelSelect}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {showSwitchProviderFooter ? (
            <div className="shrink-0 border-t px-1 py-1">
              <button
                type="button"
                data-picker-footer-action
                onClick={() => setProviderRevealed(true)}
                className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <IconArrowsExchange className="size-3.5" />
                <span>{t("toolbar.switchAgent")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
