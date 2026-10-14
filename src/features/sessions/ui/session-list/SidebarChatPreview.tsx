import { IconDeviceDesktop, IconMessageCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { formatSidebarChatTimestamp } from "./sidebarChatTimestamp";

export function SidebarChatPreview({
  title,
  activityAt,
  projectId,
  isRunning,
}: {
  title: string;
  activityAt?: string | null;
  projectId: string | null;
  isRunning: boolean;
}) {
  const { t } = useTranslation("sidebar");
  const project = useProjectStore((state) =>
    state.projects.find((item) => item.id === projectId),
  );
  const timestamp = formatSidebarChatTimestamp(activityAt);
  return (
    <div className="space-y-2 px-1 py-1">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 break-words font-semibold">
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
          <IconDeviceDesktop className="size-3.5" aria-hidden="true" />
          {timestamp && (
            <time dateTime={activityAt ?? undefined}>{timestamp}</time>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {project ? (
          <ProjectIcon
            icon={project.icon}
            color={project.color}
            projectId={project.id}
            className="size-4 shrink-0"
            imageClassName="size-4 shrink-0 rounded-sm"
          />
        ) : (
          <IconMessageCircle className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 break-words">
          {project?.name ?? t("flat.noProject")}
        </span>
      </div>
      {isRunning && (
        <div className="text-xs text-muted-foreground">
          {t("status.chatActive")}
        </div>
      )}
    </div>
  );
}
