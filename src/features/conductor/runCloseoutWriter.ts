import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import { createSystemNotificationMessage } from "@/shared/types/messages";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { isDesktopRuntime } from "@/shared/api/distillStore";
import { invoke } from "@tauri-apps/api/core";

import { useConductorGraphStore } from "./conductorGraphStore";
import { buildRunCloseout, closeoutFileName } from "./runCloseout";
import type { WaveTelemetryRecord } from "./waveTelemetryStore";

/**
 * Writing a finished root request's closeout into the project (P55).
 *
 * The effectful half of `runCloseout`, kept apart from it so what the file
 * says can be tested without a folder. Called from the one place every wave
 * close already goes through, for the same reason the run journal is derived
 * rather than emitted: a close path that forgot to write a closeout would be
 * indistinguishable from a request that produced none.
 *
 * Only a root request that actually finished gets one. A revision is not the
 * end of anything — its own close is followed by another wave — and a wave
 * that was superseded, pruned or stopped mid-flight has nothing to record
 * that the transcript does not already say better.
 */

/** Root requests this process has already written. One file per request. */
const written = new Set<string>();

export function resetRunCloseoutsForTests(): void {
  written.clear();
}

/** True when this outcome ends the root request rather than continuing it. */
export function closesTheRootRequest(
  outcome: WaveTelemetryRecord["outcome"],
): boolean {
  return outcome === "accepted" || outcome === "needs-operator";
}

/**
 * Writes the closeout for the root request this record belongs to.
 *
 * Returns the file's path, or `null` when there was nothing to write or
 * nowhere to write it — a chat outside a project, a project with no folder,
 * a browser with no desktop shell behind it. Never throws: a closeout is a
 * courtesy to the operator's future self, and failing to leave one must not
 * touch the loop that just finished the work.
 */
export async function writeRunCloseout(
  record: WaveTelemetryRecord,
  allRecords: readonly WaveTelemetryRecord[],
): Promise<string | null> {
  try {
    if (!isDesktopRuntime()) return null;
    if (!closesTheRootRequest(record.outcome)) return null;
    if (written.has(record.rootRequestId)) return null;

    const graph = useConductorGraphStore.getState();
    const conductor = graph.nodesById[record.conductorSessionId];
    const projectId =
      conductor?.projectId ||
      useChatSessionStore.getState().getSession(record.conductorSessionId)
        ?.projectId ||
      "";
    if (!projectId) return null;
    const project = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === projectId);
    const root = project?.workingDirs?.[0]?.trim();
    if (!root) return null;

    const waves = [...allRecords, record]
      .filter(
        (candidate, index, list) =>
          candidate.rootRequestId === record.rootRequestId &&
          list.findIndex((other) => other.waveId === candidate.waveId) ===
            index,
      )
      .sort((left, right) => left.createdAt - right.createdAt);

    const title =
      useChatSessionStore.getState().getSession(record.conductorSessionId)
        ?.title || "Run";
    const markdown = buildRunCloseout({
      waves,
      title,
      at: record.closedAt,
      reportOf: (runId) => graph.getReport(runId),
      runIdOf: (waveId, stepIndex) =>
        Object.values(graph.nodesById).find(
          (node) => node.waveId === waveId && node.stepIndex === stepIndex,
        )?.runId,
    });

    const name = closeoutFileName(title, record.closedAt);
    written.add(record.rootRequestId);
    const path = await invoke<string>("write_project_run_closeout", {
      projectRoot: root,
      name,
      contents: markdown,
    });
    // Said in the chat, because a file nobody knows about is a file nobody
    // commits — and being committed with the work is the whole point of
    // writing it outside `.distill`.
    useChatStore
      .getState()
      .addMessage(
        record.conductorSessionId,
        createSystemNotificationMessage(
          i18n.t("chat:conductor.wave.closeout", { path }),
          "info",
        ),
      );
    return path;
  } catch (error) {
    console.error("Failed to write the run closeout:", error);
    return null;
  }
}
