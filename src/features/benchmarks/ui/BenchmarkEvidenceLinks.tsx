import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";

const PAGE_SIZE = 5;

/** Numbered links into sealed attempts, five at a time. */
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
  const paged = attemptIds.length > PAGE_SIZE;
  return (
    <div className="flex flex-wrap items-center gap-1 whitespace-normal">
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
      {paged ? (
        <>
          <span className="px-1 text-xs text-muted-foreground">
            {t("evidence.range", {
              start: attemptIds.length ? start + 1 : 0,
              end,
              total: attemptIds.length,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={start === 0}
            aria-label={t("actions.previous")}
            onClick={() => setPageStartId(attemptIds[start - PAGE_SIZE])}
          >
            ‹
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={end === attemptIds.length}
            aria-label={t("actions.next")}
            onClick={() => setPageStartId(attemptIds[end])}
          >
            ›
          </Button>
        </>
      ) : null}
    </div>
  );
}
