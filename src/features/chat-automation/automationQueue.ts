import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { parseStructuredReport } from "@/features/conductor/orchestratorReport";
import {
  createSystemNotificationMessage,
  type MessageMetadata,
} from "@/shared/types/messages";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { admitSystemInheritedQueuedMessage } from "@/features/chat/lib/admittedSend";
import { flockctlCrossSessionSendOptions } from "@/features/chat/lib/queuedMessageOrigin";

export function automationNotice(
  id: string,
  text: string,
  metadata?: Partial<MessageMetadata>,
) {
  const message = createSystemNotificationMessage(text);
  message.metadata = { ...message.metadata, ...metadata };
  useChatStore.getState().addMessage(id, message);
}

let commandSession: string | undefined;

export function withCommandNotice(id: string, update: () => void) {
  const previous = commandSession;
  commandSession = id;
  try {
    update();
  } finally {
    commandSession = previous;
  }
}

export function automationTransitionNotice(id: string, text: string) {
  // Commands provide their own acknowledgement, including one receipt for a bulk command.
  if (commandSession !== id) automationNotice(id, text);
}

export function reportAutomationTransition(
  id: string,
  text: string,
  senderLabel: string,
  deliveryId: string,
  status: "completed" | "blocked",
) {
  const graph = useConductorGraphStore.getState();
  const child = graph.nodesById[id];
  if (!child?.parentSessionId) return;
  if (child.runId)
    graph.attachReport({
      ...parseStructuredReport(child.runId, status, text),
      publishedToParent: true,
    });
  enqueueAutomationTurn(child.parentSessionId, text, {
    senderLabel,
    deliveryId,
  });
}

export function enqueueAutomationTurn(
  sessionId: string,
  text: string,
  options: {
    senderLabel: string;
    deliveryId: string;
    metadata?: Record<string, unknown>;
  },
) {
  const sendOptions = flockctlCrossSessionSendOptions(options);
  sendOptions.acpPromptMetadata = {
    ...sendOptions.acpPromptMetadata,
    ...options.metadata,
  };
  return useChatStore
    .getState()
    .enqueueTransportReadyMessage(
      sessionId,
      admitSystemInheritedQueuedMessage({ text, sendOptions }),
    );
}
