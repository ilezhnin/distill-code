import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { parseHistoryPage } from "@/features/chat/acp/acpNotificationHandler";
import { sanitizeReplayMessages } from "@/features/chat/lib/replaySanitizer";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { BenchmarkAlert, BenchmarkEmpty } from "./BenchmarkPrimitives";

/**
 * A finished attempt keeps no chat: its sessions are removed once it settles.
 * Its turn is read back from the sealed evidence and shown read-only, the way
 * a chat replays its history.
 */
export function BenchmarkTranscriptDialog({
  attemptId,
  onClose,
}: {
  attemptId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const transcript = useQuery({
    queryKey: [...benchmarkKeys, "transcript", attemptId],
    queryFn: async () =>
      sanitizeReplayMessages(
        await parseHistoryPage(
          `benchmark-transcript:${attemptId}`,
          await benchmarkApi.getTranscript(attemptId),
          0,
        ),
      ),
    // A sealed record never changes.
    staleTime: Infinity,
  });
  const messages = transcript.data ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("evidence.transcriptTitle")}</DialogTitle>
          <DialogDescription>
            {t("evidence.transcriptDescription")}
          </DialogDescription>
        </DialogHeader>
        {transcript.error ? (
          <BenchmarkAlert>
            {benchmarkErrorMessage(transcript.error)}
          </BenchmarkAlert>
        ) : transcript.isPending ? (
          <BenchmarkEmpty compact title={t("evidence.transcriptLoading")} />
        ) : messages.length === 0 ? (
          <BenchmarkEmpty compact title={t("evidence.transcriptEmpty")} />
        ) : (
          <div className="h-[70vh] min-h-0">
            <MessageTimeline messages={messages} className="h-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
