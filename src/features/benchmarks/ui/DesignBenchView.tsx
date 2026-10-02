import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import {
  modelNameKey,
  useModelCatalog,
  useModelNames,
} from "../hooks/useBenchmarks";
import { modelDisplayName, providerVendor } from "../lib/benchmarkLabels";
import {
  previewDocument,
  renderable,
  type RenderableMarkup,
} from "../lib/benchmarkPreview";
import { resolveCatalogEntry } from "../lib/modelCatalog";
import type { DesignEntry } from "../types";
import {
  BenchmarkEmpty,
  FilterMenu,
  ModelIdentity,
  type Option,
  SectionHeading,
  StateBadge,
} from "./BenchmarkPrimitives";

interface Brief {
  versionId: string;
  name: string;
  entries: DesignEntry[];
}

/**
 * The design gallery: every brief with the newest rendering per
 * configuration side by side. A rendering stays anonymous until its blind
 * review is recorded; opening a card opens that review.
 */
export function DesignBenchView({
  entries,
  loading,
  onEvidence,
}: {
  entries: DesignEntry[];
  loading: boolean;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const names = useModelNames();
  const catalog = useModelCatalog();
  const [brief, setBrief] = useState("all");
  const briefs = useMemo(() => {
    const groups = new Map<string, Brief>();
    for (const entry of entries) {
      const group = groups.get(entry.versionId) ?? {
        versionId: entry.versionId,
        name: entry.name,
        entries: [],
      };
      group.entries.push(entry);
      groups.set(entry.versionId, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [entries]);
  const options: Option[] = [
    { value: "all", label: t("design.allBriefs") },
    ...briefs.map((group) => ({ value: group.versionId, label: group.name })),
  ];
  const shown = briefs.filter(
    (group) => brief === "all" || group.versionId === brief,
  );
  const identity = (entry: DesignEntry) => {
    const modelName =
      entry.configuration.modelName ??
      names.get(modelNameKey(entry.configuration));
    const fact = resolveCatalogEntry(
      catalog,
      entry.configuration,
      modelName,
      entry.finishedAt ?? entry.runCreatedAt,
    );
    return {
      name:
        fact?.displayName ?? modelDisplayName(entry.configuration, modelName),
      vendor: fact?.vendor ?? providerVendor(entry.configuration.providerId),
    };
  };
  if (loading) return <BenchmarkEmpty title={t("loading")} compact />;
  if (entries.length === 0)
    return (
      <BenchmarkEmpty
        title={t("design.empty")}
        description={t("design.emptyHint")}
      />
    );
  return (
    <section className="space-y-8">
      {briefs.length > 1 ? (
        <div>
          <FilterMenu
            label={t("design.brief")}
            value={brief}
            options={options}
            onChange={setBrief}
          />
        </div>
      ) : null}
      {shown.map((group) => (
        <section key={group.versionId} className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={group.name} />
            <span className="text-xs text-muted-foreground">
              {t("design.designs", { count: group.entries.length })}
            </span>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {group.entries.map((entry, index) => {
              const { name, vendor } = identity(entry);
              return (
                <DesignCard
                  key={entry.attemptId}
                  entry={entry}
                  number={index + 1}
                  name={name}
                  vendor={vendor}
                  onOpen={() => onEvidence(entry.attemptId)}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}

function DesignCard({
  entry,
  number,
  name,
  vendor,
  onOpen,
}: {
  entry: DesignEntry;
  number: number;
  name: string;
  vendor: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const markup = renderable(entry.output, entry.outputFormat);
  const points = entry.review ? Math.round(entry.review.score * 1000) : null;
  const state =
    entry.phase === "terminal"
      ? (entry.outcome ?? "pending_review")
      : entry.phase;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("design.open", { number })}
        className="group w-full overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-white">
          {markup ? (
            <DesignThumbnail markup={markup} />
          ) : (
            <div className="flex h-full items-center justify-center bg-muted">
              <StateBadge state={state} />
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 p-3">
          {entry.review ? (
            <ModelIdentity
              configuration={entry.configuration}
              name={name}
              vendor={vendor}
            />
          ) : (
            <div className="min-w-0">
              <div className="font-medium">{t("design.entry", { number })}</div>
              <div className="text-xs text-muted-foreground">
                {t("design.awaitingReview")}
              </div>
            </div>
          )}
          <span
            className={cn(
              "shrink-0 font-display text-xl font-semibold tabular-nums",
              points == null && "text-muted-foreground",
            )}
          >
            {points ?? "–"}
          </span>
        </div>
      </button>
    </li>
  );
}

/** A drawing as an image, a page in a scaled, script-free frame. */
function DesignThumbnail({ markup }: { markup: RenderableMarkup }) {
  const { t } = useTranslation("benchmarks");
  if (markup.kind === "svg") {
    const body = markup.body.includes("xmlns=")
      ? markup.body
      : markup.body.replace(
          /<svg\b/i,
          '<svg xmlns="http://www.w3.org/2000/svg"',
        );
    return (
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`}
        alt=""
        className="h-full w-full object-contain"
      />
    );
  }
  return (
    <iframe
      sandbox=""
      srcDoc={previewDocument(markup.body, "html") ?? ""}
      title={t("evidence.preview")}
      tabIndex={-1}
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 h-[300%] w-[300%] origin-top-left scale-[0.3333]"
    />
  );
}
