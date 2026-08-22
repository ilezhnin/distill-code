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
    <div className="h-full w-full overflow-y-auto">
      <div className="page-transition relative flex min-h-full flex-col items-center justify-center px-6 pb-4">
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
