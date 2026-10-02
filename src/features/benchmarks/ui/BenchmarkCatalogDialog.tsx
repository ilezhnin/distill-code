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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys, useModelCatalog } from "../hooks/useBenchmarks";
import { formatContext, formatPrice } from "../lib/modelCatalog";
import type { CatalogEntry } from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  SectionHeading,
} from "./BenchmarkPrimitives";

interface Draft {
  id: string;
  needle: string;
  providerId: string;
  displayName: string;
  vendor: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  context: string;
  effectiveFrom: string;
  source: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDraft(): Draft {
  return {
    id: "",
    needle: "",
    providerId: "",
    displayName: "",
    vendor: "",
    input: "",
    output: "",
    cacheRead: "",
    cacheWrite: "",
    context: "",
    effectiveFrom: today(),
    source: "",
  };
}

function draftOf(entry: CatalogEntry): Draft {
  const text = (value: number | null) => (value == null ? "" : String(value));
  return {
    id: entry.id,
    needle: entry.needle,
    providerId: entry.providerId ?? "",
    displayName: entry.displayName ?? "",
    vendor: entry.vendor ?? "",
    input: text(entry.inputPerMillion),
    output: text(entry.outputPerMillion),
    cacheRead: text(entry.cacheReadPerMillion),
    cacheWrite: text(entry.cacheWritePerMillion),
    context: text(entry.contextTokens),
    effectiveFrom: new Date(entry.effectiveFrom).toISOString().slice(0, 10),
    source: entry.source,
  };
}

function number(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Dated vendor facts behind the price and context columns. Saving a changed
 * price as a new entry keeps every older measurement priced as it was.
 */
export function BenchmarkCatalogDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const entries = useModelCatalog();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<Draft>) =>
    setDraft((previous) => ({ ...previous, ...patch }));
  const numbers = {
    input: number(draft.input),
    output: number(draft.output),
    cacheRead: number(draft.cacheRead),
    cacheWrite: number(draft.cacheWrite),
    context: number(draft.context),
  };
  const effectiveFrom = Date.parse(`${draft.effectiveFrom}T00:00:00Z`);
  const valid =
    draft.needle.trim().length > 0 &&
    Number.isFinite(effectiveFrom) &&
    Object.values(numbers).every(
      (value) => value == null || (Number.isFinite(value) && value >= 0),
    );
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await client.invalidateQueries({ queryKey: benchmarkKeys });
      setDraft(emptyDraft());
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() =>
      benchmarkApi.saveCatalogEntry({
        id: draft.id,
        kind: "model",
        providerId: draft.providerId.trim() || null,
        needle: draft.needle.trim().toLowerCase(),
        displayName: draft.displayName.trim() || null,
        vendor: draft.vendor.trim() || null,
        inputPerMillion: numbers.input,
        outputPerMillion: numbers.output,
        cacheReadPerMillion: numbers.cacheRead,
        cacheWritePerMillion: numbers.cacheWrite,
        contextTokens:
          numbers.context == null ? null : Math.round(numbers.context),
        effectiveFrom,
        checkedAt: Date.now(),
        source: draft.source.trim(),
        createdAt: 0,
      }),
    );
  const field = (
    key: keyof Draft,
    label: string,
    options: { type?: string; hint?: string } = {},
  ) => (
    <Field label={label} hint={options.hint}>
      {(id) => (
        <Input
          id={id}
          type={options.type ?? "text"}
          value={draft[key]}
          onChange={(event) => update({ [key]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("catalog.title")}</DialogTitle>
          <DialogDescription>{t("catalog.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          {entries.length === 0 ? (
            <BenchmarkEmpty title={t("catalog.empty")} compact />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("fields.model")}</TableHead>
                  <TableHead className="text-right">
                    {t("catalog.columns.price")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("catalog.columns.cache")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("leaderboard.context")}
                  </TableHead>
                  <TableHead>{t("catalog.columns.effective")}</TableHead>
                  <TableHead>{t("catalog.columns.checked")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-normal">
                      <div className="font-medium">
                        {entry.displayName ?? entry.needle}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {[
                          entry.vendor,
                          entry.providerId ?? t("catalog.anyProvider"),
                          entry.needle,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(entry) ?? "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.cacheReadPerMillion == null &&
                      entry.cacheWritePerMillion == null
                        ? "–"
                        : `${entry.cacheReadPerMillion ?? "–"} / ${entry.cacheWritePerMillion ?? "–"}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatContext(entry.contextTokens) ?? "–"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(entry.effectiveFrom, { dateStyle: "medium" })}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span title={entry.source}>
                        {formatDate(entry.checkedAt, { dateStyle: "medium" })}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() => setDraft(draftOf(entry))}
                        >
                          {t("catalog.edit")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          destructive
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              benchmarkApi.deleteCatalogEntry(entry.id),
                            )
                          }
                        >
                          {t("actions.remove")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <section className="space-y-4">
            <SectionHeading
              title={
                draft.id
                  ? t("catalog.editing", {
                      name: draft.displayName || draft.needle,
                    })
                  : t("catalog.newEntry")
              }
              description={t("catalog.history")}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {field("needle", t("catalog.fields.needle"), {
                hint: t("catalog.fields.needleHint"),
              })}
              {field("providerId", t("catalog.fields.provider"), {
                hint: t("catalog.fields.providerHint"),
              })}
              {field("displayName", t("catalog.fields.displayName"))}
              {field("vendor", t("catalog.fields.vendor"))}
              {field("input", t("catalog.fields.input"), { type: "number" })}
              {field("output", t("catalog.fields.output"), { type: "number" })}
              {field("cacheRead", t("catalog.fields.cacheRead"), {
                type: "number",
              })}
              {field("cacheWrite", t("catalog.fields.cacheWrite"), {
                type: "number",
              })}
              {field("context", t("catalog.fields.context"), {
                type: "number",
              })}
              {field("effectiveFrom", t("catalog.fields.effectiveFrom"), {
                type: "date",
              })}
            </div>
            {field("source", t("catalog.fields.source"), {
              hint: t("catalog.fields.sourceHint"),
            })}
          </section>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            flush
            className="sm:mr-auto"
            disabled={busy}
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
          {draft.id ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(emptyDraft())}
            >
              {t("catalog.startNew")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            disabled={busy || !valid}
            onClick={() => void save()}
          >
            {t("catalog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
