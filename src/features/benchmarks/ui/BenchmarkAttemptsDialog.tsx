import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
import type { BenchmarkVersion } from "../types";
import { BenchmarkAttemptList } from "./BenchmarkAttemptList";
import { SectionHeading } from "./BenchmarkPrimitives";

/** A report row opened: its summary, then every attempt behind the number. */
export function BenchmarkAttemptsDialog({
  title,
  description,
  attemptIds,
  versions,
  children,
  onEvidence,
  onClose,
}: {
  title: string;
  description: string;
  attemptIds: string[];
  versions: BenchmarkVersion[];
  children?: ReactNode;
  onEvidence: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {children}
          <section className="space-y-3">
            <SectionHeading
              title={t("attempts.title", { count: attemptIds.length })}
            />
            {attemptIds.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("results.empty")}
              </p>
            ) : (
              <BenchmarkAttemptList
                query={{ attemptIds }}
                versions={versions}
                onEvidence={onEvidence}
              />
            )}
          </section>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            flush
            className="sm:mr-auto"
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
