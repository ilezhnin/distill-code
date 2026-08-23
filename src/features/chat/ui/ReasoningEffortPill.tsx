import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { ChatSessionReasoningEffortConfig } from "../stores/chatSessionStore";
import {
  hasSelectableReasoningEffort,
  isTopTierEffortId,
  selectedReasoningEffortLabel,
  toSentenceCaseLabel,
} from "../lib/effectiveReasoningEffort";

interface ReasoningEffortPillProps {
  config?: ChatSessionReasoningEffortConfig;
  onSelect?: (value: string) => void;
  disabled?: boolean;
  triggerTabIndex?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Compact composer pill exposing the session's reasoning-effort options as a
 * horizontal stop track (the Claude Code effort widget): one stop per option
 * in the order received, the selected stop rendered as a knob. Hidden when
 * the session offers fewer than two options; an "off" selection still shows
 * the pill so effort can be turned back up.
 */
export function ReasoningEffortPill({
  config,
  onSelect,
  disabled = false,
  triggerTabIndex,
  open: controlledOpen,
  onOpenChange,
}: ReasoningEffortPillProps) {
  const { t } = useTranslation("chat");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  if (!hasSelectableReasoningEffort(config)) {
    return null;
  }

  const selectedIndex = config.options.findIndex(
    (option) => option.id === config.currentValue,
  );
  const currentLabel = selectedReasoningEffortLabel(config);
  // The top-tier stop is the reference widget's violet one; the theme has no
  // brand accent token, so the tint is explicit for both schemes.
  const ultracodeSelected = isTopTierEffortId(config.currentValue);
  // How far the fill runs, as a share of the distance between the first and
  // last stop centres. A selection the config doesn't list leaves the rail
  // empty rather than guessing a position for it.
  const fillRatio =
    selectedIndex > 0 && config.options.length > 1
      ? selectedIndex / (config.options.length - 1)
      : 0;

  const selectIndex = (index: number) => {
    const option = config.options[index];
    if (!option || option.id === config.currentValue) {
      return;
    }
    onSelect?.(option.id);
    // Keep keyboard focus on the stop that now holds the roving tabindex.
    requestAnimationFrame(() => {
      trackRef.current
        ?.querySelector<HTMLElement>(`[data-effort-index="${index}"]`)
        ?.focus();
    });
  };

  const handleTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const lastIndex = config.options.length - 1;
    const fromIndex = selectedIndex < 0 ? 0 : selectedIndex;
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextIndex = Math.max(0, fromIndex - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextIndex = Math.min(lastIndex, fromIndex + 1);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    selectIndex(nextIndex);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerActionButton
          type="button"
          size="sm"
          disabled={disabled}
          tabIndex={triggerTabIndex}
          aria-label={t("toolbar.reasoningEffortCurrent", {
            value: currentLabel,
          })}
          tooltip={t("toolbar.reasoningEffort")}
          className="shrink-0"
        >
          <span
            className={cn(
              ultracodeSelected && "text-violet-600 dark:text-violet-400",
            )}
          >
            {currentLabel}
          </span>
        </ComposerActionButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-56 p-3"
      >
        <div className="flex items-baseline gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("toolbar.effort")}</span>
          <span
            className={cn(
              "font-semibold",
              ultracodeSelected
                ? "text-violet-600 dark:text-violet-400"
                : "text-foreground",
            )}
          >
            {currentLabel}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("toolbar.effortFaster")}</span>
          <span>{t("toolbar.effortSmarter")}</span>
        </div>
        <div
          className={cn(
            "effort-track relative mt-1.5",
            ultracodeSelected && "effort-track-ultracode",
          )}
          style={
            {
              "--effort-fill": `calc((100% - 1.5rem) * ${fillRatio})`,
            } as CSSProperties
          }
        >
          <div aria-hidden="true" className="effort-rail" />
          <div aria-hidden="true" className="effort-fill" />
          {ultracodeSelected ? (
            <div aria-hidden="true" className="effort-sheen" />
          ) : null}
          <div
            ref={trackRef}
            role="radiogroup"
            aria-label={t("toolbar.reasoningEffort")}
            className="relative flex items-center justify-between"
            onKeyDown={handleTrackKeyDown}
          >
            {config.options.map((option, index) => {
              const isSelected =
                selectedIndex < 0
                  ? option.id === config.currentValue
                  : index === selectedIndex;
              const optionLabel = toSentenceCaseLabel(
                option.name ?? option.id,
              );
              return (
                // biome-ignore lint/a11y/useSemanticElements: deliberate ARIA radio pattern — an <input type="radio"> cannot host this icon-only roving-tabindex segmented control, and the wrapper already carries role="radiogroup"
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  data-effort-index={index}
                  aria-checked={isSelected}
                  aria-label={optionLabel}
                  title={optionLabel}
                  tabIndex={
                    isSelected || (selectedIndex < 0 && index === 0) ? 0 : -1
                  }
                  onClick={() => selectIndex(index)}
                  className="group flex h-6 w-6 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative rounded-full transition-[width,height,background-color] duration-150",
                      isSelected
                        ? cn("effort-knob h-4 w-2", "bg-foreground")
                        : cn(
                            "effort-stop-dot size-1.5",
                            isTopTierEffortId(option.id)
                              ? "bg-violet-500/60 group-hover:bg-violet-500 dark:bg-violet-400/60 dark:group-hover:bg-violet-400"
                              : "bg-muted-foreground/50 group-hover:bg-muted-foreground",
                          ),
                    )}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
