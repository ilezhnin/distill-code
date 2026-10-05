import { IconFolderPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { ReviewQueuePanel } from "@/features/review/ui/ReviewQueuePanel";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PAGE_GUTTER_CLASS } from "@/shared/ui/page-shell";

import { HomeComposer } from "./HomeComposer";
import type { HomeScreenProps } from "./HomeScreen";

/**
 * The home view since the widget desktop was cut: an invitation to start.
 *
 * The desktop this replaces had already been emptied to a bare panel — the
 * widgets were deliberately abandoned — and `features/home` went with it. What
 * home actually needs to offer is the two ways work begins here: a new chat
 * (the composer itself, wired to the persistent home session so typing simply
 * starts one) and a new project. Underneath sit the two things a person wants
 * on arriving: what finished while they were away, and their own list. Both
 * are their own features; this component stays the header of that page, not a
 * dashboard.
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
    // The scroller always reserves its scrollbar track and the inner padding
    // gives it back (the page frame's gutters), so the centered column stays
    // centered whether or not the page scrolls.
    <div
      className="h-full w-full overflow-y-scroll [scrollbar-gutter:stable]"
      data-testid="home-welcome"
    >
      <div
        className={cn(
          "page-transition relative flex min-h-full flex-col items-center justify-center gap-8 py-8",
          PAGE_GUTTER_CLASS,
        )}
      >
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
              flush
              data-testid="home-new-project"
              onClick={() => onCreateProject?.()}
            >
              <IconFolderPlus className="size-4" />
              {t("welcome.newProject")}
            </Button>
          </div>
        </div>
        <div className="flex w-full max-w-[600px] flex-col gap-6">
          <ReviewQueuePanel onOpenSession={onActivateSession} />
        </div>
      </div>
    </div>
  );
}
