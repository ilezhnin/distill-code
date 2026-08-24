import { IconFolderPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/ui/button";

import { HomeComposer } from "./HomeComposer";
import type { HomeScreenProps } from "./HomeScreen";

/**
 * The home view since the widget desktop was cut: an invitation to start.
 *
 * The desktop this replaces had already been emptied to a bare panel — the
 * widgets were deliberately abandoned — and `features/home` went with it. What
 * home actually needs to offer is the two ways work begins here: a new chat
 * (the composer itself, wired to the persistent home session so typing simply
 * starts one) and a new project. The planner lands underneath this view as its
 * own feature; this component stays the header of that page, not a dashboard.
 */
export function WelcomeView({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onWorkspaceNameRequest,
  onCreateProject,
}: HomeScreenProps) {
  const { t } = useTranslation("home");
  return (
    <div className="h-full w-full overflow-y-auto" data-testid="home-welcome">
      <div className="page-transition relative flex min-h-full flex-col items-center justify-center px-6 pb-4">
        <div className="flex w-full max-w-[600px] flex-col gap-6 antialiased">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <h1 className="text-2xl font-semibold text-foreground">
              {t("welcome.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("welcome.subtitle")}
            </p>
          </div>
          <HomeComposer
            sessionId={sessionId}
            onActivateSession={onActivateSession}
            onCreatePersona={onCreatePersona}
            onCreateProject={onCreateProject}
            onWorkspaceNameRequest={onWorkspaceNameRequest}
          />
          <div className="flex justify-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              data-testid="home-new-project"
              onClick={() => onCreateProject?.()}
            >
              <IconFolderPlus className="size-4" />
              {t("welcome.newProject")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
