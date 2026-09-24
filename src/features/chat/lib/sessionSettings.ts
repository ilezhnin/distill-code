import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { readEffectiveSettings } from "@/shared/preferences/rootSettings";
import { getStyleGuidelinesPrompt } from "@/shared/preferences/styleGuidelinesPreference";

export async function sessionStyleGuidelinesPrompt(
  sessionId: string,
): Promise<string> {
  const projectId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.projectId;
  const project = projectId
    ? useProjectStore
        .getState()
        .projects.find((candidate) => candidate.id === projectId)
    : undefined;
  const settings = await readEffectiveSettings(project?.workingDirs?.[0]);
  const style = settings["style-guidelines"];
  const prompt =
    typeof style === "string"
      ? style
      : style && typeof style === "object" && "prompt" in style
        ? style.prompt
        : undefined;
  return typeof prompt === "string" ? prompt : getStyleGuidelinesPrompt();
}
