import { useConductorTranscript } from "../ConductorTranscriptContext";
import { brigadeNodesForMessage } from "../brigadeAnchors";
import { ConductorAgentFooter } from "./ConductorAgentFooter";

/**
 * The chip row of the agents one turn started, with their stop controls.
 *
 * `messageId` is the turn's own message id, the one its agents are anchored
 * to. A turn that used tools is drawn as work rows plus an answer row whose
 * ids are derived from it (`<id>:answer`), so the row that hosts the footer
 * must pass the turn's id rather than its own: looked up by the row's id, the
 * agents an ordinary chat started from a tool call had no row at all, and
 * nothing in that chat could stop them.
 */
export function TurnAgentFooter({
  messageId,
  className,
}: {
  messageId: string;
  className?: string;
}) {
  const transcript = useConductorTranscript();
  if (!transcript.enabled) return null;
  const nodes = brigadeNodesForMessage(
    transcript.brigadeNodesByMessageId,
    messageId,
  );
  // A plan with nothing spawned yet still has a row to draw: the placeholder
  // chips are the operator's only view of what they just agreed to, and the
  // window where none of it has started is exactly when they look.
  const planSteps = transcript.wavePlanStepsByMessageId.get(messageId);
  if (nodes.length === 0 && (planSteps?.length ?? 0) === 0) return null;
  return (
    <ConductorAgentFooter
      hostSessionId={transcript.hostSessionId}
      nodes={nodes}
      reportsByRunId={transcript.reportsByRunId}
      planSteps={planSteps}
      onOpen={transcript.onOpenChild}
      onStop={transcript.onStopChild}
      workingListedBelow={transcript.workingListedBelow}
      className={className}
    />
  );
}
