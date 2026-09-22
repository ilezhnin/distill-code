import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

/** Existing project instructions remain a prompt channel alongside AGENTS.md. */
export function formatProjectInstructionsPrompt(
  project: Pick<ProjectInfo, "prompt"> | null | undefined,
): string | undefined {
  const content = project?.prompt?.trim();
  if (!content) return undefined;
  return [
    "<project-instructions>",
    "These are the operator's instructions for this project. Apply them to this project's work.",
    "",
    content.replace(/<\/project-instructions>/gi, "<\\/project-instructions>"),
    "</project-instructions>",
  ].join("\n");
}

export function sessionProjectInstructionsPrompt(
  sessionId: string,
): string | undefined {
  const projectId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.projectId;
  if (!projectId) return undefined;
  return formatProjectInstructionsPrompt(
    useProjectStore
      .getState()
      .projects.find((project) => project.id === projectId),
  );
}
