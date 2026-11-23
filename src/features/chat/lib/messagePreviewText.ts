import { automationPreviewTask } from "@/features/chat-automation/automationProtocol";
import { stripProtocolFences } from "@/shared/lib/protocolFences";

export function messagePreviewText(text: string) {
  return stripProtocolFences(automationPreviewTask(text), "preview");
}
