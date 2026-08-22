import { getTextContent, type Message } from "@/shared/types/messages";

export function userMessagesNeedingOrchestrator({
  messages,
  hydratedUserMessageIds,
  childAnchorMessageIds,
}: {
  messages: readonly Message[];
  hydratedUserMessageIds: ReadonlySet<string>;
  childAnchorMessageIds: ReadonlySet<string>;
}): Message[] {
  const needed: Message[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (hydratedUserMessageIds.has(message.id)) continue;
    if (childAnchorMessageIds.has(message.id)) continue;
    if (
      message.metadata?.origin === "berdctl_cross_session" ||
      message.metadata?.origin === "operator_direct"
    ) {
      continue;
    }
    if (
      message.metadata?.delivery === "steer" ||
      message.metadata?.delivery === "steering"
    ) {
      continue;
    }
    if (!getTextContent(message).trim()) continue;
    needed.push(message);
  }
  return needed;
}
