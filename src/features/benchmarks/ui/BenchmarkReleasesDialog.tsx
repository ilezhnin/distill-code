import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys, useBenchmarkReleases } from "../hooks/useBenchmarks";
import {
  liveVersionIds,
  nextReleaseName,
  poolChanges,
  type PoolChanges,
} from "../lib/benchmarkReleases";
import type { BenchmarkDefinition } from "../types";
import { BenchmarkAlert, Field, SectionHeading } from "./BenchmarkPrimitives";

/**
 * The pool's releases, newest first, and what a new one would freeze: every
 * live test's newest version, against the newest release.
 */
export function BenchmarkReleasesDialog({
  definitions,
  onClose,
}: {
  definitions: BenchmarkDefinition[];
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const releases = useBenchmarkReleases();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = liveVersionIds(definitions);
  const newest = releases.at(-1) ?? null;
  const pending = poolChanges(definitions, newest?.versionIds ?? [], live);
  const unchanged =
    pending.added + pending.revised + pending.retired === 0 || !live.length;
  const changesLabel = (changes: PoolChanges) =>
    t("releases.changes", { ...changes });
  const release = async () => {
    setBusy(true);
    setError(null);
    try {
      await benchmarkApi.createRelease(name.trim() || null);
      setName("");
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("releases.title")}</DialogTitle>
          <DialogDescription>{t("releases.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <section className="space-y-3">
            <SectionHeading title={t("releases.unreleased")} />
            <p className="text-sm text-muted-foreground" role="status">
              {newest && unchanged
                ? t("releases.matches", { name: newest.name })
                : `${t("releases.tests", { count: live.length })} · ${changesLabel(pending)}`}
            </p>
            <div className="flex items-end gap-2">
              <Field label={t("releases.name")} className="flex-1">
                {(id) => (
                  <Input
                    id={id}
                    value={name}
                    placeholder={nextReleaseName(releases)}
                    maxLength={40}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="primary"
                disabled={busy || unchanged}
                onClick={() => void release()}
              >
                {t("releases.release")}
              </Button>
            </div>
          </section>
          <section className="space-y-3">
            <SectionHeading title={t("releases.history")} />
            {releases.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("releases.empty")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {[...releases].reverse().map((entry) => {
                  const index = releases.indexOf(entry);
                  const previous = releases[index - 1]?.versionIds ?? [];
                  return (
                    <li
                      key={entry.id}
                      className="flex items-baseline justify-between gap-4 py-2 text-sm"
                    >
                      <span className="font-medium">{entry.name}</span>
                      <span className="flex-1 text-muted-foreground">
                        {formatDate(entry.createdAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {t("releases.tests", {
                          count: entry.versionIds.length,
                        })}
                        {" · "}
                        {changesLabel(
                          poolChanges(definitions, previous, entry.versionIds),
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
