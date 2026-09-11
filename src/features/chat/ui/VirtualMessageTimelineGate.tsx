import { useMemo, type ComponentProps, type RefObject } from "react";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import type { MessageTimeline } from "./MessageTimeline";
import { VirtualMessageTimeline } from "./VirtualMessageTimeline";
import { createLoadedTranscriptState } from "../transcript/virtual/react/useTranscriptVirtualTimeline";

type MessageTimelineProps = ComponentProps<typeof MessageTimeline>;

interface VirtualMessageTimelineGateProps extends MessageTimelineProps {
  sessionId: string;
  /** Filled by the virtual timeline with its indexed search backend. */
  searchBackendRef?: RefObject<TranscriptSearchBackend | null>;
}

/**
 * The chat transcript renderer. The virtual timeline is the only production
 * path; the classic `MessageTimeline` survives for the child chat panel and
 * as the renderer the virtual bridge draws rows with.
 */
export function VirtualMessageTimelineGate({
  sessionId,
  searchBackendRef,
  ...timelineProps
}: VirtualMessageTimelineGateProps) {
  const loadedTranscript = useMemo(
    () => createLoadedTranscriptState(sessionId),
    [sessionId],
  );

  return (
    <VirtualMessageTimeline
      loadedTranscript={loadedTranscript}
      sessionId={sessionId}
      searchBackendRef={searchBackendRef}
      {...timelineProps}
    />
  );
}
