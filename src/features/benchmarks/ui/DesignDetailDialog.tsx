import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { benchmarkApi } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { formatElapsed, formatSpend } from "../lib/benchmarkLabels";
import { renderable } from "../lib/benchmarkPreview";
import type { DesignEntry, DesignPoint } from "../types";
import { BenchmarkEmpty, Metric, ModelIdentity } from "./BenchmarkPrimitives";
import { DesignRendering } from "./DesignRendering";

/** The card's own attempt as a point, for a backend that lists none. */
function ownPoint(entry: DesignEntry): DesignPoint {
  return {
    attemptId: entry.attemptId,
    runId: entry.runId,
    repetition: 0,
    finishedAt: entry.finishedAt,
    durationMs: entry.durationMs,
    cost: entry.cost,
    score: entry.score,
    judges: entry.judges.length,
    rendering: entry.rendering ?? null,
  };
}

/**
 * One model's design of one brief: the large rendering and a switch across
 * every scored rendering behind it, each with its own image, score and time.
 */
export function DesignDetailDialog({
  entry,
  name,
  vendor,
  onClose,
  onEvidence,
}: {
  entry: DesignEntry;
  name: string;
  vendor: string;
  onClose: () => void;
  onEvidence: (attemptId: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const points = entry.points?.length ? entry.points : [ownPoint(entry)];
  const [shownId, setShownId] = useState(
    points.some((point) => point.attemptId === entry.attemptId)
      ? entry.attemptId
      : points[0].attemptId,
  );
  const point =
    points.find((candidate) => candidate.attemptId === shownId) ?? points[0];
  // A point the panel never rendered shows its own markup, read on demand.
  const evidence = useQuery({
    queryKey: [...benchmarkKeys, "evidence", point.attemptId],
    queryFn: () => benchmarkApi.getEvidence(point.attemptId),
    enabled: !point.rendering && point.attemptId !== entry.attemptId,
  });
  const output =
    point.attemptId === entry.attemptId
      ? entry.output
      : (evidence.data?.output ?? null);
  const score = point.score == null ? null : Math.round(point.score * 1000);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{entry.name}</DialogTitle>
          <DialogDescription asChild>
            <div>
              <ModelIdentity
                configuration={entry.configuration}
                name={name}
                vendor={vendor}
              />
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {points.length > 1 ? (
            <ToggleGroup
              type="single"
              size="sm"
              aria-label={t("design.points")}
              className="flex-wrap justify-start"
              value={point.attemptId}
              onValueChange={(value) => {
                if (value) setShownId(value);
              }}
            >
              {points.map((candidate) => (
                <ToggleGroupItem
                  key={candidate.attemptId}
                  value={candidate.attemptId}
                >
                  {t("design.point", {
                    date:
                      candidate.finishedAt == null
                        ? t("unknown")
                        : formatDate(candidate.finishedAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                    number: candidate.repetition + 1,
                  })}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          <div className="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-border bg-white">
            <DesignRendering
              key={point.attemptId}
              rendering={point.rendering}
              markup={renderable(output, entry.outputFormat)}
              scale="full"
              fallback={
                <div className="flex h-full items-center justify-center bg-muted">
                  <BenchmarkEmpty
                    title={
                      evidence.isFetching ? t("loading") : t("design.noImage")
                    }
                    compact
                  />
                </div>
              }
            />
          </div>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label={t("design.score")} value={score ?? "–"} />
            <Metric
              label={t("design.judgesLabel")}
              value={point.judges > 0 ? point.judges : "–"}
            />
            <Metric
              label={t("fields.elapsed")}
              value={formatElapsed(t, point.durationMs)}
            />
            <Metric
              label={t("fields.cost")}
              value={formatSpend(t, point.cost, null)}
            />
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onEvidence(point.attemptId)}
          >
            {t("design.evidence")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
