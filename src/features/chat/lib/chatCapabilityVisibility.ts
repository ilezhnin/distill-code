import type { ChatSession } from "../stores/chatSessionStore";

export function isAgentBuilderVisible(
  session: ChatSession | null | undefined,
): boolean {
  return (
    session?.intent === "build-agent" && session.agentBuilderOpen !== false
  );
}

export function isContextPanelVisible(
  session: ChatSession | null | undefined,
  isRightRailOpen: boolean,
): boolean {
  if (!isRightRailOpen) {
    return false;
  }

  return (
    !isAgentBuilderVisible(session) ||
    session?.agentBuilderContextState === "userOpened"
  );
}
