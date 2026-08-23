import { AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { IconLayoutSidebarLeftExpand, IconX } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ArtifactViewer } from "./ArtifactViewer";
import { SidePanelShell } from "./SidePanelShell";
import {
  useArtifactViewerStore,
  useOpenArtifact,
  useOpenArtifactTabs,
  type OpenArtifact,
} from "../stores/artifactViewerStore";

const VIEWER_WIDTH_STORAGE_KEY = "goose:artifact-viewer-width";

interface ArtifactViewerPanelProps {
  sessionId: string;
  chatCollapsed?: boolean;
  onToggleChat?: () => void;
}

/**
 * The file viewer surface of the shared side region. Sizing, resizing and the
 * enter/exit slide all live in `SidePanelShell`, which the child-chat tabs
 * mount through as well.
 */
export function ArtifactViewerPanel({
  sessionId,
  chatCollapsed = false,
  onToggleChat,
}: ArtifactViewerPanelProps) {
  const artifact = useOpenArtifact(sessionId);

  return (
    <AnimatePresence initial={false}>
      {artifact ? (
        <ViewerPanel
          key="artifact-viewer"
          sessionId={sessionId}
          artifact={artifact}
          chatCollapsed={chatCollapsed}
          onToggleChat={onToggleChat}
        />
      ) : null}
    </AnimatePresence>
  );
}

function ViewerPanel({
  sessionId,
  artifact,
  chatCollapsed,
  onToggleChat,
}: {
  sessionId: string;
  artifact: OpenArtifact;
  chatCollapsed: boolean;
  onToggleChat?: () => void;
}) {
  const { t } = useTranslation("chat");
  const tabs = useOpenArtifactTabs(sessionId);
  const activate = useArtifactViewerStore((s) => s.activate);
  const closeTab = useArtifactViewerStore((s) => s.closeTab);

  return (
    <SidePanelShell
      widthStorageKey={VIEWER_WIDTH_STORAGE_KEY}
      fillWorkspace={chatCollapsed}
      resizeLabel={t("artifactViewer.resize")}
      dataAttributes={{ "data-artifact-viewer-panel": "" }}
    >
      <FileViewerTabBar
        tabs={tabs}
        activePath={artifact.resolvedPath}
        showChatButton={chatCollapsed && Boolean(onToggleChat)}
        onShowChat={onToggleChat}
        onActivate={(path) => activate(sessionId, path)}
        onCloseTab={(path) => closeTab(sessionId, path)}
      />
      <ArtifactViewer
        artifact={artifact}
        onClose={() => closeTab(sessionId, artifact.resolvedPath)}
        showFilename={false}
        showClose={false}
      />
    </SidePanelShell>
  );
}

function FileViewerTabBar({
  tabs,
  activePath,
  showChatButton,
  onShowChat,
  onActivate,
  onCloseTab,
}: {
  tabs: readonly OpenArtifact[];
  activePath: string;
  showChatButton: boolean;
  onShowChat?: () => void;
  onActivate: (path: string) => void;
  onCloseTab: (path: string) => void;
}) {
  const { t } = useTranslation("chat");

  return (
    <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border/80 px-1">
      {showChatButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("artifactViewer.showChat")}
              title={t("artifactViewer.showChat")}
              onClick={onShowChat}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <IconLayoutSidebarLeftExpand
                className="size-4"
                aria-hidden="true"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("artifactViewer.showChat")}</TooltipContent>
        </Tooltip>
      ) : null}
      <div
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
        role="tablist"
        aria-label={t("artifactViewer.tabs")}
      >
        {tabs.map((tab) => {
          const isActive = tab.resolvedPath === activePath;
          return (
            <div
              key={tab.resolvedPath}
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
                title={tab.resolvedPath}
                onClick={() => onActivate(tab.resolvedPath)}
                className="min-w-0 truncate px-2.5 py-1.5 text-left text-xs"
              >
                {tab.filename}
              </button>
              <button
                type="button"
                aria-label={t("artifactViewer.closeTab", {
                  filename: tab.filename,
                })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.resolvedPath);
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
    </div>
  );
}
