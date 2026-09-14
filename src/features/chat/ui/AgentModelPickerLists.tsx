import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { ModelOption } from "../types";
import { PickerItem } from "./AgentModelPickerItem";

/**
 * Long lists are where search is most needed, so the search affordance appears
 * once the harness offers more than this many rows across both pages.
 */
const SEARCHABLE_LIST_THRESHOLD = 8;

function getModelDisplayName(model: ModelOption) {
  return model.displayName ?? model.name;
}

export function modelMatchesSelection(
  model: ModelOption,
  currentModelId: string | null,
  currentModelProviderId: string | null,
) {
  if (model.id !== currentModelId) {
    return false;
  }

  if (currentModelProviderId) {
    return model.providerId === currentModelProviderId;
  }

  // Providerless selections are ambiguous legacy/incomplete state, so fall back
  // to model-ID-only matching until the user selects a concrete provider row.
  return true;
}

/**
 * Rows the harness filed under "More models". A row it did not file belongs on
 * the main page: hiding an advertised model would be the app deciding what the
 * harness serves.
 */
export function isMoreModel(model: ModelOption): boolean {
  return model.group === "more";
}

/**
 * The harness's own menu order and nothing else. Rows never move depending on
 * what is selected, because a menu whose rows move cannot be learned.
 */
function sortByMenuOrder(models: ModelOption[]) {
  return [...models].sort((left, right) => {
    const leftOrder = left.order ?? left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder =
      right.order ?? right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return getModelDisplayName(left).localeCompare(getModelDisplayName(right));
  });
}

interface ModelRowProps {
  model: ModelOption;
  selected: boolean;
  runActive: boolean;
  tabIndex?: number;
  onSelect: (model: ModelOption) => void;
}

function ModelRow({
  model,
  selected,
  runActive,
  tabIndex,
  onSelect,
}: ModelRowProps) {
  const { t } = useTranslation("chat");
  const name = getModelDisplayName(model);
  // Such a model runs only in a session opened on it, and the host refuses to
  // reopen a session mid-turn, so the click could only fail. The current row
  // stays enabled: choosing it again changes nothing.
  const blocked = runActive && model.opensOnModel === true && !selected;
  const row = (
    <PickerItem
      onClick={() => onSelect(model)}
      selected={selected}
      disabled={blocked}
      tabIndex={tabIndex}
      className="justify-between"
    >
      <div className="min-w-0 flex-1 truncate">{name}</div>
      {selected ? (
        <IconCheck className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
    </PickerItem>
  );

  if (!blocked) {
    return row;
  }

  // A disabled button fires no pointer events, so the tooltip hangs off a
  // wrapper that still does.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block">{row}</span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {t("toolbar.modelNeedsIdleSession", { model: name })}
      </TooltipContent>
    </Tooltip>
  );
}

interface ModelListProps {
  /** Every row for the selected agent, from both pages. */
  models: ModelOption[];
  currentModelId: string | null;
  currentModelProviderId: string | null;
  /** A turn is running, so rows that reopen the session are unavailable. */
  runActive?: boolean;
  /** Whether the "More models" column is showing. */
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  onModelSelect: (model: ModelOption) => void;
  /**
   * Reports whether the list is showing search results, so the picker can hide
   * affordances that would interrupt browsing.
   */
  onBrowseChange?: (browsing: boolean) => void;
  /** Rows pinned below the model list, inside the model column. */
  footer?: ReactNode;
}

export interface ModelListHandle {
  /** Closes search or the "More models" page; false when neither was open. */
  closeOverlay: () => boolean;
}

export const ModelList = forwardRef<ModelListHandle, ModelListProps>(
  function ModelList(
    {
      models,
      currentModelId,
      currentModelProviderId,
      runActive = false,
      moreOpen,
      onMoreOpenChange,
      onModelSelect,
      onBrowseChange,
      footer,
    },
    ref,
  ) {
    const { t } = useTranslation("chat");
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const searchButtonRef = useRef<HTMLButtonElement>(null);
    const restoreSearchButtonFocusRef = useRef(false);
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const resetScroll = useCallback(() => {
      const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      if (viewport) {
        viewport.scrollTop = 0;
      }
    }, []);

    const mainModels = useMemo(
      () => sortByMenuOrder(models.filter((model) => !isMoreModel(model))),
      [models],
    );
    const selectedMoreModel = useMemo(
      () =>
        models.find(
          (model) =>
            isMoreModel(model) &&
            modelMatchesSelection(
              model,
              currentModelId,
              currentModelProviderId,
            ),
        ) ?? null,
      [models, currentModelId, currentModelProviderId],
    );
    const hasMoreModels = useMemo(() => models.some(isMoreModel), [models]);

    // Search is the flat union of both pages, ungrouped, so an older model is
    // findable without knowing which page the harness filed it under.
    const searchResults = useMemo(() => {
      const normalizedQuery = query.trim().toLowerCase();
      const matches = normalizedQuery
        ? models.filter(
            (model) =>
              model.name.toLowerCase().includes(normalizedQuery) ||
              model.id.toLowerCase().includes(normalizedQuery) ||
              model.displayName?.toLowerCase().includes(normalizedQuery) ||
              model.providerName?.toLowerCase().includes(normalizedQuery) ||
              model.providerId?.toLowerCase().includes(normalizedQuery),
          )
        : models;
      return sortByMenuOrder(matches);
    }, [models, query]);
    const visibleModels = searchOpen ? searchResults : mainModels;

    useEffect(() => {
      if (searchOpen) {
        inputRef.current?.focus();
      } else if (restoreSearchButtonFocusRef.current) {
        restoreSearchButtonFocusRef.current = false;
        searchButtonRef.current?.focus();
      }
    }, [searchOpen]);

    useEffect(() => {
      onBrowseChange?.(searchOpen);
    }, [searchOpen, onBrowseChange]);
    // Unmounting (agent switch, models cleared) leaves no view to browse.
    useEffect(() => {
      return () => {
        onBrowseChange?.(false);
      };
    }, [onBrowseChange]);

    const showSearchButton = models.length > SEARCHABLE_LIST_THRESHOLD;
    const closeSearch = useCallback(() => {
      resetScroll();
      restoreSearchButtonFocusRef.current = true;
      setQuery("");
      setSearchOpen(false);
    }, [resetScroll]);
    useImperativeHandle(
      ref,
      () => ({
        closeOverlay: () => {
          if (searchOpen) {
            closeSearch();
            return true;
          }
          if (moreOpen) {
            onMoreOpenChange(false);
            return true;
          }
          return false;
        },
      }),
      [closeSearch, moreOpen, onMoreOpenChange, searchOpen],
    );
    const openSearch = () => {
      resetScroll();
      onMoreOpenChange(false);
      setSearchOpen(true);
    };
    const handleSelect = (model: ModelOption) => {
      onModelSelect(model);
      if (searchOpen) {
        // A pick from search lands back on the main page, even when the model
        // lives under "More models".
        setQuery("");
        setSearchOpen(false);
        onMoreOpenChange(false);
        resetScroll();
      }
    };

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center px-1">
          {searchOpen ? (
            <div
              data-model-search-open
              className="relative mr-2 min-w-0 flex-1"
            >
              <SearchBar
                inputRef={inputRef}
                size="picker"
                value={query}
                onChange={(nextQuery) => {
                  resetScroll();
                  setQuery(nextQuery);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.stopPropagation();
                  }
                }}
                placeholder={t("toolbar.searchModels")}
                aria-label={t("toolbar.searchModels")}
                className="min-w-0 origin-right animate-in fade-in zoom-in-95 duration-150 ease-out motion-reduce:animate-none"
              />
              <Button
                variant="ghost"
                size="icon-xxs"
                onClick={closeSearch}
                className="absolute top-1/2 right-1 -translate-y-1/2"
                aria-label={t("search.close")}
                title={t("search.close")}
              >
                <IconX />
              </Button>
            </div>
          ) : (
            <span className="flex flex-1 items-center justify-between text-sm font-semibold">
              <span>{t("toolbar.model")}</span>
              {showSearchButton ? (
                <Button
                  ref={searchButtonRef}
                  variant="ghost"
                  size="icon-xxs"
                  onClick={openSearch}
                  className="mr-3"
                  aria-label={t("toolbar.searchModels")}
                  title={t("toolbar.searchModels")}
                >
                  <IconSearch />
                </Button>
              ) : null}
            </span>
          )}
        </div>
        {visibleModels.length > 0 ? (
          <ScrollArea
            ref={scrollAreaRef}
            className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
          >
            <div className="space-y-0.5 p-1 pr-3">
              {visibleModels.map((model) => (
                <ModelRow
                  key={`${model.providerId ?? "model"}:${model.id}`}
                  model={model}
                  selected={modelMatchesSelection(
                    model,
                    currentModelId,
                    currentModelProviderId,
                  )}
                  runActive={runActive}
                  onSelect={handleSelect}
                />
              ))}
              {hasMoreModels && !searchOpen ? (
                // The selection check lives here when the chosen model is on
                // the other page, so the main page never hides what is chosen.
                // It is deliberately not `selected`: the picker's focus rules
                // look for the selected model row, which is on that page.
                <PickerItem
                  data-picker-more-trigger
                  aria-expanded={moreOpen}
                  onClick={() => onMoreOpenChange(true)}
                  className="justify-between"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t("toolbar.moreModels")}
                  </span>
                  {selectedMoreModel ? (
                    <>
                      <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                        {getModelDisplayName(selectedMoreModel)}
                      </span>
                      <IconCheck className="size-4 shrink-0 text-muted-foreground" />
                    </>
                  ) : null}
                  <IconChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </PickerItem>
              ) : null}
            </div>
          </ScrollArea>
        ) : (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            {t("toolbar.noSearchResults")}
          </div>
        )}
        {footer}
      </div>
    );
  },
);

interface MoreModelListProps {
  /** Every row for the selected agent; only the "More models" rows show. */
  models: ModelOption[];
  currentModelId: string | null;
  currentModelProviderId: string | null;
  runActive?: boolean;
  /** Hidden columns keep their rows out of the tab order. */
  hidden: boolean;
  onBack: () => void;
  onModelSelect: (model: ModelOption) => void;
}

export function MoreModelList({
  models,
  currentModelId,
  currentModelProviderId,
  runActive = false,
  hidden,
  onBack,
  onModelSelect,
}: MoreModelListProps) {
  const { t } = useTranslation("chat");
  const moreModels = useMemo(
    () => sortByMenuOrder(models.filter(isMoreModel)),
    [models],
  );
  const tabIndex = hidden ? -1 : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center">
        <PickerItem
          data-picker-back
          onClick={onBack}
          tabIndex={tabIndex}
          className="text-muted-foreground hover:text-foreground"
        >
          <IconChevronLeft className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t("toolbar.backToModels")}</span>
        </PickerItem>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="space-y-0.5 p-1">
          {moreModels.map((model) => (
            <ModelRow
              key={`${model.providerId ?? "model"}:${model.id}`}
              model={model}
              selected={modelMatchesSelection(
                model,
                currentModelId,
                currentModelProviderId,
              )}
              runActive={runActive}
              tabIndex={tabIndex}
              onSelect={onModelSelect}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
