import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";

const PAGE_SIZE = 5;

export function BenchmarkEvidenceLinks({
  attemptIds,
  onEvidence,
}: {
  attemptIds: string[];
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [pageStartId, setPageStartId] = useState<string | null>(null);
  // Keep the same evidence page across refreshes; a replaced cohort starts over.
  const start =
    Math.floor(Math.max(0, attemptIds.indexOf(pageStartId ?? "")) / PAGE_SIZE) *
    PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, attemptIds.length);
  return (
    <div className="w-64 space-y-1 whitespace-normal">
      <div className="flex flex-wrap gap-1">
        {attemptIds.slice(start, end).map((id, index) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onEvidence(id)}
          >
            {start + index + 1}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("evidence.range", {
          start: attemptIds.length ? start + 1 : 0,
          end,
          total: attemptIds.length,
        })}
      </p>
      {attemptIds.length > PAGE_SIZE && (
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={start === 0}
            onClick={() => setPageStartId(attemptIds[start - PAGE_SIZE])}
          >
            {t("actions.previous")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={end === attemptIds.length}
            onClick={() => setPageStartId(attemptIds[end])}
          >
            {t("actions.next")}
          </Button>
        </div>
      )}
    </div>
  );
}
