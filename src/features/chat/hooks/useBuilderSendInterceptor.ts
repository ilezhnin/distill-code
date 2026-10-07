import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { ChatSendOptions } from "@/features/chat/types";

// The editor needs the application file contract, not an operator's skill body.
const AGENT_FILE_INSTRUCTIONS = [
  "Edit the agent Markdown draft according to the user's request.",
  "Keep its YAML frontmatter between --- delimiters and its instructions in the Markdown body.",
  "Use the name and description frontmatter fields for the displayed identity.",
  "Preserve existing fields and provider/model configuration unless the user requests a change.",
  "Do not copy personal profiles, private roles or local skills into the draft unless explicitly requested.",
].join("\n");

export function resolveAgentBuilderSkillBody(
  skillBody = AGENT_FILE_INSTRUCTIONS,
) {
  return skillBody;
}

const SKILL_BODY = resolveAgentBuilderSkillBody();
const sentStaticPromptByPath = new Set<string>();

export function composeBuilderSendOptions(
  session:
    | Pick<ChatSession, "intent" | "agentBuilderOpen" | "targetAgentPath">
    | null
    | undefined,
  options: ChatSendOptions = {},
): ChatSendOptions {
  if (
    session?.intent !== "build-agent" ||
    session.agentBuilderOpen === false ||
    !session.targetAgentPath
  ) {
    return options;
  }

  const pathNote = [
    "agent-builder session path instructions:",
    "This session is bound to an existing draft that the app is previewing.",
    "Follow the editor's file ownership requirements:",
    `- Edit exactly this file: ${session.targetAgentPath}`,
    "- Do not rename, move, delete, or replace it with a new slug-named file.",
    "- Update the frontmatter name for the agent's display name, but keep the filename/path unchanged.",
    "- Preserve every existing frontmatter key, especially draft and builderSessionId.",
  ].join("\n");
  const existingAssistantPrompt = options.assistantPrompt?.trim();
  const hasStaticPrompt =
    existingAssistantPrompt?.includes(SKILL_BODY.trim()) ?? false;
  const shouldSendStaticPrompt =
    !hasStaticPrompt && !sentStaticPromptByPath.has(session.targetAgentPath);
  const builderPrompt = shouldSendStaticPrompt
    ? `${SKILL_BODY}\n\n${pathNote}`
    : pathNote;
  sentStaticPromptByPath.add(session.targetAgentPath);

  return {
    ...options,
    assistantPrompt: existingAssistantPrompt
      ? `${builderPrompt}\n\n${existingAssistantPrompt}`
      : builderPrompt,
  };
}
