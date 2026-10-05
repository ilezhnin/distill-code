import { cn } from "@/shared/lib/cn";
import { PAGE_GUTTER_CLASS } from "@/shared/ui/page-shell";
import { HomeComposer } from "./HomeComposer";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";

export interface HomeScreenProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
}

export function HomeScreen({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onWorkspaceNameRequest,
  onCreateProject,
}: HomeScreenProps) {
  return (
    // The scroller always reserves its scrollbar track and the inner padding
    // gives it back (the page frame's gutters), so the centered column stays
    // centered whether or not the page scrolls.
    <div className="h-full w-full overflow-y-scroll [scrollbar-gutter:stable]">
      <div
        className={cn(
          "page-transition relative flex min-h-full flex-col items-center justify-center pb-4",
          PAGE_GUTTER_CLASS,
        )}
      >
        <div className="flex w-full max-w-[600px] flex-col antialiased">
          <HomeComposer
            sessionId={sessionId}
            onActivateSession={onActivateSession}
            onCreatePersona={onCreatePersona}
            onCreateProject={onCreateProject}
            onWorkspaceNameRequest={onWorkspaceNameRequest}
          />
        </div>
      </div>
    </div>
  );
}
