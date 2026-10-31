import { isDefaultChatTitle } from "@/features/chat/lib/sessionTitle";

import { useConductorGraphStore } from "./conductorGraphStore";
import { pickUniqueDisplayName } from "./pickUniqueDisplayName";

/**
 * Keep a conductor's graph label in sync with the chat title.
 *
 * The chat list is distinguished by the sitemap icon, not by "Producer N".
 * The agents tree still reads `displayName`, so once a real title exists
 * (prompt placeholder, harness summary, or operator rename) the node follows
 * it. Role placeholders ("Producer", "Producer 2") stay until then.
 *
 * A session another chat started through flockctl follows its title too: it
 * is registered before it has one, and its parent shows it by this label.
 * Wave and in-app children keep the names they were given on purpose.
 */
export function syncConductorDisplayNameFromTitle(
  sessionId: string,
  title: string,
): void {
  const nextTitle = title.trim();
  if (!nextTitle || isDefaultChatTitle(nextTitle)) {
    return;
  }

  const graph = useConductorGraphStore.getState();
  const node = graph.getNode(sessionId);
  if (node?.role !== "conductor" && node?.managedBy !== "agent-cli") {
    return;
  }
  if (node.displayName === nextTitle) {
    return;
  }

  const used = Object.values(graph.nodesById)
    .filter((candidate) => candidate.sessionId !== sessionId)
    .map((candidate) => candidate.displayName);
  graph.patchNode(sessionId, {
    displayName: pickUniqueDisplayName(nextTitle, used),
  });
}
