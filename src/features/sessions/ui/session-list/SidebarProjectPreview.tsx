import {
  IconFolder,
  IconMessageCircle,
  IconSettings,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";
import type { SidebarSessionItem } from "./SidebarProjectSection";

export function SidebarProjectPreview({
  project,
  chats,
  hasMoreSessions,
  onEdit,
}: {
  project: ProjectInfo;
  chats: SidebarSessionItem[];
  hasMoreSessions: boolean;
  onEdit?: (projectId: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  const activeCount = chats.filter((chat) => chat.isRunning).length;
  return (
    <>
      <div className="flex items-start gap-2 px-1 py-1">
        <ProjectIcon
          icon={project.icon}
          color={project.color}
          projectId={project.id}
          className="mt-0.5 size-4 shrink-0"
          imageClassName="mt-0.5 size-4 shrink-0 rounded-sm"
        />
        <span className="min-w-0 break-words font-semibold">
          {project.name}
        </span>
      </div>
      <div className="flex items-center gap-2 px-1 py-1">
        <IconMessageCircle className="size-4 shrink-0 text-muted-foreground" />
        <span>
          {t("projectPreview.chats", {
            count: chats.length,
            displayCount: `${chats.length}${hasMoreSessions ? "+" : ""}`,
          })}
          {activeCount > 0
            ? ` · ${t("projectPreview.active", { count: activeCount })}`
            : ""}
        </span>
      </div>
      {project.workingDirs.length > 0 && (
        <>
          <Separator className="my-1" />
          <div className="max-h-40 overflow-y-auto">
            {project.workingDirs.map((path) => (
              <div key={path} className="flex items-start gap-2 px-1 py-2">
                <IconFolder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-all select-text">{path}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {onEdit && (
        <>
          <Separator className="my-1" />
          <Button
            type="button"
            variant="ghost"
            size="compact"
            leftIcon={<IconSettings />}
            className="w-full justify-start px-1"
            onClick={() => onEdit(project.id)}
          >
            {t("actions.editProjectFallback")}
          </Button>
        </>
      )}
    </>
  );
}
