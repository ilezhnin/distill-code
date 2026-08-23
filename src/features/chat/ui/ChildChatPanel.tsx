import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowUpRight,
  IconLayoutSidebarLeftExpand,
  IconX,
} from "@tabler/icons-react";

import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  ConductorTranscriptProvider,
  type ConductorTranscriptContextValue,
} from "@/features/conductor/ConductorTranscriptContext";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { RunStatus } from "@/features/conductor/types";
import { BrigadeStatusGlyph } from "@/features/conductor/ui/BrigadeChip";
import { cn } from "@/shared/lib/cn";
import type { Message } from "@/shared/types/messages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { MessageTimeline } from "./MessageTimeline";
import { SidePanelShell } from "./SidePanelShell";
import {
  useActiveChildChatTab,
  useChildChatTabsStore,
  useOpenChildChatTabs,
  type ChildChatTab,
} from "../stores/childChatTabsStore";

const CHILD_CHAT_WIDTH_STORAGE_KEY = "goose:child-chat-panel-width";
const EMPTY_MESSAGES: Message[] = [];

/**
 * The panel mounts inside the host conversation's `ConductorTranscriptProvider`.
 * Overriding it with an inert value keeps the host's per-message brigade map
 * from being consulted for the child's messages, which belong to a different
 * transcript entirely.
 */
const INERT_CONDUCTOR_TRANSCRIPT: ConductorTranscriptContextValue = {
  enabled: false,
  children: [],
  reportsByRunId: {},
  brigadeNodesByMessageId: new Map(),
  wavePlanStepsByMessageId: new Map(),
};

interface ChildChatPanelProps {
  /** The conversation the tabs belong to. */
  hostSessionId: string;
  chatCollapsed?: boolean;
  onToggleChat?: () => void;
  /** Full navigation: leave this conversation and open the child as the chat. */
  onNavigateToChild?: (childSessionId: string) => void;
}

/**
 * Child transcripts, open beside the conversation instead of replacing it.
 *
 * The body is **read-only**: the child's real transcript, live, with no
 * composer. Talking to a worker from inside the panel would mean a second
 * composer with its own queue, draft, attachments and send/steer/stop
 * lifecycle — the whole of `useChatSessionController` — mounted for a session
 * this window does not own. The tab header therefore carries a one-click
 * "open fully", which is the existing full navigation (and brings back the
 * `ConductorBackBanner` on the way in).
 */
export function ChildChatPanel({
  hostSessionId,
  chatCollapsed = false,
  onToggleChat,
  onNavigateToChild,
}: ChildChatPanelProps) {
  const activeTab = useActiveChildChatTab(hostSessionId);

  return (
    <AnimatePresence initial={false}>
      {activeTab ? (
        <ChildChatPanelBody
          key="child-chat-panel"
          hostSessionId={hostSessionId}
          activeTab={activeTab}
          chatCollapsed={chatCollapsed}
          onToggleChat={onToggleChat}
          onNavigateToChild={onNavigateToChild}
        />
      ) : null}
    </AnimatePresence>
  );
}

function ChildChatPanelBody({
  hostSessionId,
  activeTab,
  chatCollapsed,
  onToggleChat,
  onNavigateToChild,
}: {
  hostSessionId: string;
  activeTab: ChildChatTab;
  chatCollapsed: boolean;
  onToggleChat?: () => void;
  onNavigateToChild?: (childSessionId: string) => void;
}) {
  const { t } = useTranslation("chat");
  const tabs = useOpenChildChatTabs(hostSessionId);
  const activate = useChildChatTabsStore((s) => s.activate);
  const closeTab = useChildChatTabsStore((s) => s.closeTab);

  return (
    <SidePanelShell
      widthStorageKey={CHILD_CHAT_WIDTH_STORAGE_KEY}
      fillWorkspace={chatCollapsed}
      resizeLabel={t("childChat.resize")}
      dataAttributes={{ "data-child-chat-panel": "" }}
    >
      <ChildChatTabBar
        tabs={tabs}
        activeChildId={activeTab.sessionId}
        showChatButton={chatCollapsed && Boolean(onToggleChat)}
        onShowChat={onToggleChat}
        onActivate={(childId) => activate(hostSessionId, childId)}
        onCloseTab={(childId) => closeTab(hostSessionId, childId)}
        onOpenFully={
          onNavigateToChild
            ? () => onNavigateToChild(activeTab.sessionId)
            : undefined
        }
      />
      <ChildChatTranscript
        key={activeTab.sessionId}
        childSessionId={activeTab.sessionId}
      />
    </SidePanelShell>
  );
}

/**
 * Live statuses for the whole strip in a single graph subscription, rather
 * than one per tab. Missing ids simply have no status — a child dropped from
 * the graph still shows its transcript under its captured name.
 */
function useChildTabStatuses(
  tabs: readonly ChildChatTab[],
): Record<string, { status: RunStatus; name: string } | undefined> {
  // Subscribes to the graph's node map itself — a stable reference the store
  // only replaces when the graph actually changes — and derives the strip's
  // slice from it, rather than building a fresh object inside the selector.
  const nodesById = useConductorGraphStore((state) => state.nodesById);
  return useMemo(() => {
    const byId: Record<string, { status: RunStatus; name: string }> = {};
    for (const tab of tabs) {
      const node = nodesById[tab.sessionId];
      if (node) {
        byId[tab.sessionId] = { status: node.status, name: node.displayName };
      }
    }
    return byId;
  }, [nodesById, tabs]);
}

function ChildChatTabBar({
  tabs,
  activeChildId,
  showChatButton,
  onShowChat,
  onActivate,
  onCloseTab,
  onOpenFully,
}: {
  tabs: readonly ChildChatTab[];
  activeChildId: string;
  showChatButton: boolean;
  onShowChat?: () => void;
  onActivate: (childSessionId: string) => void;
  onCloseTab: (childSessionId: string) => void;
  onOpenFully?: () => void;
}) {
  const { t } = useTranslation("chat");
  const liveById = useChildTabStatuses(tabs);
  const activeName =
    liveById[activeChildId]?.name ??
    tabs.find((tab) => tab.sessionId === activeChildId)?.name ??
    "";

  return (
    <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border/80 px-1">
      {showChatButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("childChat.showChat")}
              title={t("childChat.showChat")}
              onClick={onShowChat}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <IconLayoutSidebarLeftExpand
                className="size-4"
                aria-hidden="true"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("childChat.showChat")}</TooltipContent>
        </Tooltip>
      ) : null}
      <div
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
        role="tablist"
        aria-label={t("childChat.tabs")}
      >
        {tabs.map((tab) => {
          const isActive = tab.sessionId === activeChildId;
          const live = liveById[tab.sessionId];
          const name = live?.name ?? tab.name;
          return (
            <div
              key={tab.sessionId}
              data-testid="child-chat-tab"
              data-status={live?.status}
              className={cn(
                "group flex max-w-[14rem] min-w-0 items-center rounded-t-md border border-transparent",
                isActive
                  ? "border-border/80 border-b-transparent bg-background text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                title={
                  live
                    ? t("conductor.openChild", {
                        name,
                        status: t(`conductor.status.${live.status}`),
                      })
                    : name
                }
                onClick={() => onActivate(tab.sessionId)}
                className="inline-flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs"
              >
                {live ? <BrigadeStatusGlyph status={live.status} /> : null}
                <span className="min-w-0 truncate">{name}</span>
              </button>
              <button
                type="button"
                aria-label={t("childChat.closeTab", { name })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.sessionId);
                }}
                className={cn(
                  "mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  !isActive &&
                    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                )}
              >
                <IconX className="size-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {onOpenFully ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="child-chat-open-fully"
              aria-label={t("childChat.openFully", { name: activeName })}
              title={t("childChat.openFully", { name: activeName })}
              onClick={onOpenFully}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <IconArrowUpRight className="size-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {t("childChat.openFully", { name: activeName })}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * The child's own transcript.
 *
 * Messages come from the chat store's per-session cache, which is where the
 * ACP notification handler already routes this child's live updates — so a
 * running worker streams into the panel with no extra subscription. When the
 * cache has nothing (the child was spawned in an earlier run, or its entry was
 * evicted), `loadSessionMessages` replays it; that call is deduplicated and
 * no-ops when messages are already present.
 */
function ChildChatTranscript({ childSessionId }: { childSessionId: string }) {
  const { t } = useTranslation("chat");
  const messages = useChatStore(
    (s) => s.messagesBySession[childSessionId] ?? EMPTY_MESSAGES,
  );
  const isLoading = useChatStore((s) =>
    s.loadingSessionIds.has(childSessionId),
  );
  const streamingMessageId = useChatStore(
    (s) => s.sessionStateById[childSessionId]?.streamingMessageId ?? null,
  );

  // Re-hydration, not a poll. The store's message cache holds ten sessions and
  // `canEvictSessionMessages` treats a settled, non-streaming session as
  // evictable — which is exactly a finished worker left open in a tab. Loading
  // once on mount therefore left the panel permanently blank after an eviction,
  // because `childSessionId` never changed.
  //
  // So the load is armed once, disarmed by the request it makes, and re-armed
  // only when a transcript we actually had is gone again. A genuinely empty
  // child transcript asks once and then stays quiet.
  const hydrationRef = useRef({ sessionId: childSessionId, armed: true });
  useEffect(() => {
    if (hydrationRef.current.sessionId !== childSessionId) {
      hydrationRef.current = { sessionId: childSessionId, armed: true };
    }
    if (messages.length > 0) {
      hydrationRef.current.armed = true;
      return;
    }
    if (isLoading || !hydrationRef.current.armed) return;
    hydrationRef.current.armed = false;
    void loadSessionMessages(childSessionId);
  }, [childSessionId, isLoading, messages]);

  const placeholder = useMemo(
    () => (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        {isLoading ? t("childChat.loading") : t("childChat.empty")}
      </p>
    ),
    [isLoading, t],
  );

  return (
    <ConductorTranscriptProvider value={INERT_CONDUCTOR_TRANSCRIPT}>
      <MessageTimeline
        messages={messages}
        streamingMessageId={streamingMessageId}
        showPlaceholder={messages.length === 0}
        placeholder={placeholder}
        className="min-h-0 flex-1"
      />
    </ConductorTranscriptProvider>
  );
}
