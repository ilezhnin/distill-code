import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronLeft,
  Copy,
  Download,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { SIDEBAR_RAISED_MENU_CONTENT_CLASS } from "@/shared/ui/sidebar-tokens";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import type { Persona } from "@/shared/types/agents";
import {
  canDeletePersona,
  canEditPersona,
  getRealPersonaDescription,
} from "@/features/agents/lib/personaPresentation";
import {
  AGENT_PROFILE_FIELDS_TRANSITION_NAME,
  getAgentAvatarTransitionName,
} from "@/features/agents/lib/agentViewTransitions";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { AgentProfileLayout } from "@/features/agents/ui/AgentProfileLayout";
import {
  AgentIdentityRail,
  type AgentIdentityMetadataItem,
} from "@/features/agents/ui/AgentIdentityRail";
import { AgentModelRankingSummary } from "@/features/agents/ui/AgentModelRankingSummary";
import {
  AVATAR_CUSTOMIZE_LABEL_CLASS,
  AVATAR_CUSTOMIZE_SURFACE_CLASS,
  AVATAR_CUSTOMIZE_TRIGGER_CLASS,
} from "@/features/agents/ui/avatarCustomizeMotion";
import { pickAgentAvatarImagePath } from "@/features/agents/lib/avatarFilePicker";
import { deleteUserAvatar, importAgentAvatarFile } from "@/shared/api/avatars";

interface AgentDetailPageProps {
  persona: Persona;
  onBack: () => void;
  onStartChat?: (persona: Persona) => void;
  onEdit: (persona: Persona) => void;
  onDuplicate: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
  onExport: (persona: Persona) => void | Promise<void>;
  onShare?: (persona: Persona) => void;
  onAvatarUpdate: (persona: Persona, avatar: string | null) => Promise<void>;
}

const CONTEXT_LABEL_CLASS =
  "text-sm leading-5 font-normal text-surface-agent-profile-fg-muted";
const SECONDARY_ACTION_CLASS =
  "bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover hover:text-surface-agent-profile-fg";
const OVERFLOW_TRIGGER_CLASS =
  "bg-surface-agent-profile-control-bg text-surface-agent-profile-fg shadow-none hover:bg-surface-agent-profile-control-bg-hover";
const ACTION_ICON_CLASS = "size-3";
const INSTRUCTIONS_PANEL_CLASS =
  "relative h-[min(32rem,calc(100vh-var(--spacing-app-top-bar)-7rem))] min-h-0 w-full overflow-hidden rounded-md bg-surface-agent-profile-control-bg text-sm leading-relaxed text-surface-agent-profile-fg shadow-none";
const INSTRUCTIONS_SCROLL_CLASS =
  "agent-instructions-scrollbar h-full overflow-y-auto overscroll-contain rounded-[inherit] p-4 outline-none scrollbar-visible focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function AgentDetailPage({
  persona,
  onBack,
  onStartChat,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
  onShare,
  onAvatarUpdate,
}: AgentDetailPageProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isEditable = canEditPersona(persona);
  const isDeletable = canDeletePersona(persona);
  const [avatarPreviewFailed, setAvatarPreviewFailed] = useState(false);
  const [avatarSavePending, setAvatarSavePending] = useState(false);
  const [previousPersonaAvatarValue, setPreviousPersonaAvatarValue] = useState(
    persona.avatar ?? "",
  );
  const [previousPersonaId, setPreviousPersonaId] = useState(persona.id);
  const avatarMedia = useAvatarMedia(persona.avatar ?? null);
  const descriptionValue = getRealPersonaDescription(persona);
  const createdLabel = persona.createdAt ? formatDate(persona.createdAt) : null;
  const updatedLabel = persona.updatedAt ? formatDate(persona.updatedAt) : null;
  const avatarTransitionName = getAgentAvatarTransitionName(persona.id);
  const fallbackAvatarSrc = resolveAgentIcon(persona.id);
  const metadata = [
    descriptionValue
      ? {
          label: t("view.description", { defaultValue: "Description" }),
          value: descriptionValue,
          multiline: true,
        }
      : null,
    // Model ranking replaced the legacy Provider/Model pair as how this
    // agent's model is chosen; the summary shows the ranking the runtime
    // walks (and surfaces a lone legacy single model instead of hiding it).
    {
      label: t("ranking.label"),
      content: <AgentModelRankingSummary persona={persona} />,
    },
    createdLabel ? { label: t("view.created"), value: createdLabel } : null,
    updatedLabel ? { label: t("view.updated"), value: updatedLabel } : null,
  ].filter(Boolean) as AgentIdentityMetadataItem[];

  if (previousPersonaAvatarValue !== (persona.avatar ?? "")) {
    setPreviousPersonaAvatarValue(persona.avatar ?? "");
    setAvatarPreviewFailed(false);
  }

  if (previousPersonaId !== persona.id) {
    setPreviousPersonaId(persona.id);
    setAvatarPreviewFailed(false);
  }

  const handleChooseAvatarFile = useCallback(async () => {
    if (!onAvatarUpdate || !isEditable || avatarSavePending) {
      return;
    }

    let importedAvatarRef: string | null = null;
    setAvatarSavePending(true);
    try {
      const sourcePath = await pickAgentAvatarImagePath();
      if (!sourcePath) {
        return;
      }

      const nextAvatar = await importAgentAvatarFile({
        agentPath: persona.id,
        sourcePath,
      });
      importedAvatarRef = nextAvatar;
      await onAvatarUpdate(persona, nextAvatar);
      setAvatarPreviewFailed(false);
    } catch (error) {
      if (importedAvatarRef) {
        void deleteUserAvatar(importedAvatarRef).catch((cleanupError) => {
          console.warn(
            "Failed to clean up unpersisted agent avatar:",
            cleanupError,
          );
        });
      } else {
        console.error("Failed to import agent avatar:", error);
        toast.error(t("avatar.importFailed"));
      }
    } finally {
      setAvatarSavePending(false);
    }
  }, [avatarSavePending, isEditable, onAvatarUpdate, persona, t]);

  const avatarPreview = (
    <div className={AVATAR_CUSTOMIZE_SURFACE_CLASS}>
      <div
        className="h-full w-full"
        style={{ viewTransitionName: avatarTransitionName }}
      >
        {avatarMedia ? (
          <AvatarMedia
            media={avatarMedia}
            alt={persona.displayName}
            className="h-full w-full object-contain drop-shadow-[var(--shadow-agent-profile-avatar)]"
            onError={() => setAvatarPreviewFailed(true)}
          />
        ) : (
          <img
            src={fallbackAvatarSrc}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-contain drop-shadow-[var(--shadow-agent-profile-avatar)]"
          />
        )}
      </div>

      {isEditable ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("editor.customizeAvatar")}
            className={AVATAR_CUSTOMIZE_TRIGGER_CLASS}
            disabled={avatarSavePending}
            onClick={() => void handleChooseAvatarFile()}
          />
          <Badge
            variant="secondary"
            className={AVATAR_CUSTOMIZE_LABEL_CLASS}
            aria-hidden="true"
          >
            {t("editor.changeAvatar")}
          </Badge>
        </>
      ) : null}
    </div>
  );

  const profileActions = (
    <>
      {onStartChat ? (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => onStartChat(persona)}
          leftIcon={<MessageCircle />}
          className={SECONDARY_ACTION_CLASS}
        >
          {t("detail.startChat")}
        </Button>
      ) : null}
      {isEditable ? (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => onEdit(persona)}
          leftIcon={<Pencil />}
          className={SECONDARY_ACTION_CLASS}
        >
          {t("common:actions.edit")}
        </Button>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("detail.moreActions")}
                className={OVERFLOW_TRIGGER_CLASS}
              >
                <MoreHorizontal className={ACTION_ICON_CLASS} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("detail.moreActions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          variant="raised"
          align="end"
          alignOffset={-4}
          sideOffset={4}
          className={SIDEBAR_RAISED_MENU_CONTENT_CLASS}
        >
          <DropdownMenuItem onSelect={() => onDuplicate(persona)}>
            <Copy className="size-3.5" />
            {t("common:actions.duplicate")}
          </DropdownMenuItem>
          {onShare ? (
            <DropdownMenuItem onSelect={() => onShare(persona)}>
              <Share2 className="size-3.5" />
              {t("share.action")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void onExport(persona)}>
              <Download className="size-3.5" />
              {t("common:actions.export")}
            </DropdownMenuItem>
          )}
          {isDeletable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDelete(persona)}
              >
                <Trash2 className="size-3.5" />
                {t("common:actions.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const profileHeader = (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-1 md:-ml-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("view.backToAgents")}
          tooltip={t("view.backToAgents")}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <h1 className="truncate text-[20px] font-normal leading-6 text-surface-agent-profile-fg">
          {persona.displayName}
        </h1>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {profileActions}
      </div>
    </div>
  );

  return (
    <AgentProfileLayout
      animateSections={false}
      fieldsTransitionName={AGENT_PROFILE_FIELDS_TRANSITION_NAME}
      header={profileHeader}
      identityRail={
        <AgentIdentityRail
          avatar={avatarPreview}
          leadingControl={null}
          metadata={metadata}
          modeControl={null}
        />
      }
    >
      <div className="space-y-6">
        <section
          className="agents-unpaired-enter space-y-3 pt-6"
          style={{ animationDelay: "80ms" }}
          aria-labelledby="agent-instructions"
        >
          <h2 id="agent-instructions" className={CONTEXT_LABEL_CLASS}>
            {t("view.instructions")}
          </h2>
          <div className={INSTRUCTIONS_PANEL_CLASS}>
            <section
              className={INSTRUCTIONS_SCROLL_CLASS}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this nested scroll region.
              tabIndex={0}
              aria-labelledby="agent-instructions"
            >
              <MessageResponse className="min-w-0 pb-4 text-sm leading-relaxed">
                {persona.systemPrompt || " "}
              </MessageResponse>
            </section>
          </div>
        </section>
        {avatarPreviewFailed ? (
          <p className="text-[11px] text-muted-foreground">
            {t("avatar.loadFailed")}
          </p>
        ) : null}
      </div>
    </AgentProfileLayout>
  );
}
