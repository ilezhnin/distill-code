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
import { shortId } from "../lib/benchmarkLabels";
import type { RunSummary } from "../types";
import { BenchmarkEmpty, StateBadge } from "./BenchmarkPrimitives";

export function BenchmarkRunsDialog({
  runs,
  onClose,
  onOpenRun,
}: {
  runs: RunSummary[];
  onClose: () => void;
  onOpenRun: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("runs.title")}</DialogTitle>
          <DialogDescription>{t("runs.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {runs.length === 0 ? (
            <BenchmarkEmpty title={t("runs.empty")} compact />
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li
                  key={run.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm">
                      {formatDate(run.createdAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                      <code className="ml-2 text-xs text-muted-foreground">
                        {shortId(run.id)}
                      </code>
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <StateBadge state={run.state} />
                      <span>
                        {t("runs.progress", {
                          completed: run.settledCount,
                          total: run.attemptCount,
                        })}
                      </span>
                      {run.request.preview ? (
                        <span>{t("runs.preview")}</span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenRun(run.id)}
                  >
                    {t("actions.inspect")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
